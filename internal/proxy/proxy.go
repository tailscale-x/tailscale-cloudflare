//go:build caddy

package proxy

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/caddyconfig"
	_ "github.com/caddyserver/caddy/v2/modules/standard"
	"github.com/caddyserver/certmagic"
	"github.com/lucaslorentz/caddy-docker-proxy/v2"
	_ "github.com/lucaslorentz/caddy-docker-proxy/v2"
	proxyconfig "github.com/lucaslorentz/caddy-docker-proxy/v2/config"
	"github.com/tailscale-x/tailscale-private-funnel/internal/report"
	_ "github.com/tailscale/caddy-tailscale"
)

// Start loads Caddy in-process. Gateway and router route generation is kept in
// this package so both modes share the same persistent process lifecycle.
func Start(mode, listen string, tailnetDial func(context.Context, string, string) (net.Conn, error)) error {
	if listen == "" {
		listen = ":8080"
	}
	if mode == "gateway" {
		listen = ":443"
	}
	if mode == "router" && os.Getenv("DOCKER_HOST") == "" {
		os.Setenv("DOCKER_HOST", "unix:///var/run/docker.sock")
	}
	stateDir := os.Getenv("FUNNEL_STATE_DIR")
	if stateDir == "" {
		stateDir = "/data/tailscale"
	}
	dataDir := os.Getenv("FUNNEL_DATA_DIR")
	if dataDir == "" {
		dataDir = "/data"
	}
	// Caddy initializes its default config and storage paths at package init,
	// before the application has resolved its XDG directories. Override both
	// paths explicitly so a non-root container never falls back to /.config or
	// /.local and reloads remain writable.
	if err := os.MkdirAll(filepath.Join(dataDir, "caddy"), 0700); err != nil {
		return fmt.Errorf("create Caddy data directory: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "config", "caddy"), 0700); err != nil {
		return fmt.Errorf("create Caddy config directory: %w", err)
	}
	_ = os.Setenv("XDG_DATA_HOME", dataDir)
	_ = os.Setenv("XDG_CONFIG_HOME", filepath.Join(dataDir, "config"))
	if os.Getenv("HOME") == "" {
		_ = os.Setenv("HOME", dataDir)
	}
	caddy.DefaultStorage = &certmagic.FileStorage{Path: filepath.Join(dataDir, "caddy")}
	caddy.ConfigAutosavePath = filepath.Join(dataDir, "config", "caddy", "autosave.json")
	hostname := os.Getenv("FUNNEL_HOSTNAME")
	if hostname == "" {
		hostname = "private-funnel"
	}
	email := os.Getenv("FUNNEL_CERT_EMAIL")
	if email == "" {
		email = "admin@example.invalid"
	}
	tailscaleBlock := ""
	if mode == "gateway" {
		tailscaleBlock = fmt.Sprintf(`
	tailscale {
		state_dir %s
		gateway {
			hostname %s
			state_dir %s
		}
	}
`, stateDir, hostname, stateDir)
	}
	config := caddyfile(mode, listen, email, dataDir, tailscaleBlock)
	adapter := caddyconfig.GetAdapter("caddyfile")
	if adapter == nil {
		return fmt.Errorf("caddyfile adapter is unavailable")
	}
	b, warnings, err := adapter.Adapt([]byte(config), nil)
	if err != nil {
		return fmt.Errorf("adapt embedded Caddy config: %w", err)
	}
	_ = warnings
	if err := caddy.Load(b, false); err != nil {
		return fmt.Errorf("load embedded Caddy config: %w", err)
	}
	if mode == "router" {
		os.Setenv("FUNNEL_DISABLE_DOCKER_EVENTS", "1")
		loader := caddydockerproxy.CreateDockerLoader(&proxyconfig.Options{
			Mode: proxyconfig.Standalone, DockerSockets: []string{os.Getenv("DOCKER_HOST")},
			IngressNetworks: []string{os.Getenv("FUNNEL_INGRESS_NETWORK")}, ProcessCaddyfile: true,
			LabelPrefix: "caddy", ProxyServiceTasks: true, PollingInterval: 30 * time.Second,
			EventThrottleInterval: 100 * time.Millisecond,
		})
		if err := loader.Start(); err != nil {
			return fmt.Errorf("start Docker label discovery: %w", err)
		}
		startReportAgent(tailnetDial)
	}
	return nil
}

func caddyfile(mode, listen, email, dataDir, tailscaleBlock string) string {
	site := fmt.Sprintf(`%s {
	}`, listen)
	if mode == "gateway" {
		site = fmt.Sprintf(`%s {
		tls {
			on_demand
		}
		reverse_proxy {
			dynamic srv _gateway._tcp.{host} {
				refresh 1m
			}
			transport tailscale gateway
		}
	}`, listen)
	}
	return fmt.Sprintf(`{
		email %s
		storage file_system %s/caddy
	%s
		on_demand_tls {
			ask http://127.0.0.1:9123/
		}
	}

	:9123 {
		respond 200
	}
	:80 {
		redir https://{host}{uri} permanent
	}

	%s
`, email, dataDir, tailscaleBlock, site)
}

// ValidateConfig adapts the embedded configuration without starting Caddy.
// Release CI calls this for both modes so syntax/module regressions fail early.
func ValidateConfig(mode string) error {
	adapter := caddyconfig.GetAdapter("caddyfile")
	if adapter == nil {
		return fmt.Errorf("caddyfile adapter is unavailable")
	}
	_, _, err := adapter.Adapt([]byte(caddyfile(mode, ":443", "admin@example.invalid", "/tmp/private-funnel", "")), nil)
	return err
}

func startReportAgent(tailnetDial func(context.Context, string, string) (net.Conn, error)) {
	management := os.Getenv("FUNNEL_MANAGEMENT_URL")
	nodeID := os.Getenv("FUNNEL_NODE_ID")
	dataDir := os.Getenv("FUNNEL_DATA_DIR")
	if management == "" || nodeID == "" || dataDir == "" {
		return
	}
	if os.Getenv("FUNNEL_TAILSCALE_IP") == "" {
		// A router report without the router's tailnet address would publish a
		// Docker bridge address that the gateway cannot reach. The app derives
		// this value from tsnet before starting the proxy.
		return
	}
	var client *http.Client
	if tailnetDial != nil {
		client = &http.Client{Transport: &http.Transport{DialContext: tailnetDial}}
	}
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			exposures, err := report.DiscoverDocker(ctx, os.Getenv("FUNNEL_INGRESS_NETWORK"))
			if err == nil {
				routerPort := uint16(18080)
				if value, parseErr := strconv.ParseUint(os.Getenv("FUNNEL_ROUTER_PORT"), 10, 16); parseErr == nil && value > 0 {
					routerPort = uint16(value)
				}
				for i := range exposures {
					exposures[i].GatewayHostname = os.Getenv("FUNNEL_GATEWAY_HOSTNAME")
					exposures[i].BackendHostname = os.Getenv("FUNNEL_HOSTNAME")
					exposures[i].Port = routerPort
					if ip := os.Getenv("FUNNEL_TAILSCALE_IP"); ip != "" {
						exposures[i].BackendIP = ip
					}
				}
				if sendErr := (report.Agent{NodeID: nodeID, ManagementURL: management, DataDir: dataDir, HTTPClient: client, GatewayHostname: os.Getenv("FUNNEL_GATEWAY_HOSTNAME")}).Send(ctx, exposures); sendErr != nil {
					slog.Error("router report submission failed", "error", sendErr)
				} else {
					slog.Info("router report submitted", "exposures", len(exposures))
				}
			} else {
				slog.Error("router Docker discovery failed", "error", err)
			}
			cancel()
			<-ticker.C
		}
	}()
}
