package report

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	dockerclient "github.com/docker/docker/client"
)

type Exposure struct {
	PublicHostname  string `json:"public_hostname"`
	BackendHostname string `json:"backend_hostname"`
	BackendIP       string `json:"backend_ip"`
	GatewayHostname string `json:"gateway_hostname"`
	Port            uint16 `json:"port"`
}

type Agent struct {
	NodeID          string
	ManagementURL   string
	DataDir         string
	HTTPClient      *http.Client
	GatewayHostname string
	BackendHostname string
	BackendIP       string
	RouterPort      uint16
	IngressNetwork  string
}

func (a Agent) Send(ctx context.Context, exposures []Exposure) error {
	if a.NodeID == "" || a.ManagementURL == "" {
		return fmt.Errorf("report node and management URL are required")
	}
	pub, priv, err := LoadOrCreate(a.DataDir + "/report-identity.json")
	if err != nil {
		return err
	}
	payload := map[string]any{"exposures": exposures, "expires_at": time.Now().Add(5 * time.Minute).Unix()}
	e, err := NewEnvelope(a.NodeID, payload, pub, priv, time.Now())
	if err != nil {
		return err
	}
	body, _ := json.Marshal(e)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(a.ManagementURL, "/")+"/api/reports", strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := a.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		message, _ := io.ReadAll(res.Body)
		return fmt.Errorf("report submission failed: HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(message)))
	}
	return nil
}

var portPattern = regexp.MustCompile(`(?i)upstreams\s+(\d+)`)

func DiscoverDocker(ctx context.Context, ingress string) ([]Exposure, error) {
	if strings.TrimSpace(ingress) == "" {
		return nil, fmt.Errorf("dedicated ingress network is required")
	}
	client, err := dockerclient.NewClientWithOpts(dockerclient.FromEnv, dockerclient.WithAPIVersionNegotiation())
	if err != nil {
		return nil, err
	}
	defer client.Close()
	containers, err := client.ContainerList(ctx, container.ListOptions{})
	if err != nil {
		return nil, err
	}
	var out []Exposure
	for _, c := range containers {
		host := strings.TrimSpace(c.Labels["caddy"])
		if parsed, parseErr := url.Parse(host); parseErr == nil && parsed.Hostname() != "" {
			host = parsed.Hostname()
		} else {
			host = strings.TrimPrefix(strings.TrimPrefix(host, "http://"), "https://")
		}
		proxy := c.Labels["caddy.reverse_proxy"]
		if host == "" || proxy == "" {
			continue
		}
		match := portPattern.FindStringSubmatch(proxy)
		if len(match) != 2 {
			continue
		}
		port, _ := strconv.ParseUint(match[1], 10, 16)
		if port == 0 {
			continue
		}
		inspect, err := client.ContainerInspect(ctx, c.ID)
		if err != nil {
			return nil, err
		}
		ip := ""
		for name, network := range inspect.NetworkSettings.Networks {
			if name == ingress {
				ip = network.IPAddress
				break
			}
		}
		if ip == "" {
			continue
		}
		out = append(out, Exposure{PublicHostname: host, BackendIP: ip, Port: uint16(port)})
	}
	return out, nil
}
