package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/tailscale-x/tailscale-private-funnel/internal/proxy"
	"github.com/tailscale-x/tailscale-private-funnel/internal/report"
	"github.com/tailscale-x/tailscale-private-funnel/internal/store"
	"github.com/tailscale-x/tailscale-private-funnel/internal/web"
	"tailscale.com/tsnet"
)

func defaults(mode string, o Options) (Options, error) {
	if o.Hostname == "" {
		o.Hostname, _ = os.Hostname()
	}
	if o.StateDir == "" {
		base := os.Getenv("XDG_STATE_HOME")
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return o, err
			}
			base = filepath.Join(home, ".local", "state")
		}
		o.StateDir = filepath.Join(base, "tailscale-private-funnel", mode)
	}
	if o.DataDir == "" {
		base := os.Getenv("XDG_DATA_HOME")
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return o, err
			}
			base = filepath.Join(home, ".local", "share")
		}
		o.DataDir = filepath.Join(base, "tailscale-private-funnel", mode)
	}
	if o.Listen == "" {
		if mode == "control" {
			o.Listen = ":8080"
		} else {
			o.Listen = ":8080"
		}
	}
	if o.LoginServer == "" {
		o.LoginServer = "https://controlplane.tailscale.com"
	}
	if mode != "control" && o.ManagementURL == "" && o.NonInteractive {
		return o, errors.New("--management-url is required for gateway and router joins")
	}
	return o, nil
}

func Join(ctx context.Context, mode string, o Options) error {
	var err error
	o, err = defaults(mode, o)
	if err != nil {
		return err
	}
	if mode == "control" && !o.NonInteractive && !o.InteractiveLogin && o.AuthKeyFile == "" && !o.AuthKeyStdin {
		return joinTUI(ctx, mode, o)
	}
	key, err := authKey(ctx, mode, o)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(o.StateDir, 0700); err != nil {
		return err
	}
	if err := os.MkdirAll(o.DataDir, 0700); err != nil {
		return err
	}
	// Keep the resolved hostname beside the application state. Status uses it
	// when no hostname flag is supplied so inspecting a live node cannot open a
	// second tsnet identity under the container's transient hostname.
	if err := os.WriteFile(filepath.Join(o.DataDir, "hostname"), []byte(o.Hostname), 0600); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(o.StateDir, "authkey"), []byte(key), 0600); err != nil {
		return err
	}
	var reportPublic string
	if mode == "router" || mode == "gateway" {
		pub, _, identityErr := report.LoadOrCreate(filepath.Join(o.DataDir, "report-identity.json"))
		if identityErr != nil {
			return identityErr
		}
		reportPublic = base64.RawStdEncoding.EncodeToString(pub)
	}
	s := &tsnet.Server{Hostname: o.Hostname, Dir: o.StateDir, AuthKey: key, ControlURL: o.LoginServer}
	if len(o.Tags) > 0 {
		s.AdvertiseTags = o.Tags
	}
	if _, err := s.Up(ctx); err != nil {
		return fmt.Errorf("join tsnet: %w", err)
	}
	defer s.Close()
	if err := waitTsnetReady(ctx, s, 45*time.Second); err != nil {
		return err
	}
	if o.EnrollmentID != "" && reportPublic != "" {
		if err := bindSigningKey(ctx, mode, o, reportPublic, tsnetHTTPClient(s)); err != nil {
			return err
		}
	}
	if o.EnrollmentID != "" {
		_ = os.WriteFile(filepath.Join(o.DataDir, "node-id"), []byte(o.EnrollmentID), 0600)
		_ = os.WriteFile(filepath.Join(o.DataDir, "management-url"), []byte(o.ManagementURL), 0600)
	}
	_ = ctx
	fmt.Printf("%s joined as %s\n", mode, o.Hostname)
	if mode == "control" {
		fmt.Printf("setup URL: http://%s\n", o.Hostname)
	}
	return nil
}

func waitTsnetReady(ctx context.Context, s *tsnet.Server, timeout time.Duration) error {
	local, err := s.LocalClient()
	if err != nil {
		return err
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		status, statusErr := local.StatusWithoutPeers(ctx)
		if statusErr == nil && status.BackendState == "Running" {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("tsnet did not become ready: %v", statusErr)
		case <-ticker.C:
		}
	}
}

func bindSigningKey(ctx context.Context, mode string, o Options, publicKey string, client *http.Client) error {
	managementURL := o.ManagementURL
	if managementURL == "" {
		managementURL = o.BootstrapURL
	}
	u, err := url.Parse(managementURL)
	if err != nil {
		return err
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/enrollments/" + url.PathEscape(o.EnrollmentID) + "/signing-key"
	q := u.Query()
	q.Set("code", o.EnrollmentCode)
	u.RawQuery = q.Encode()
	body, _ := json.Marshal(map[string]string{"public_key": publicKey})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
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
		return fmt.Errorf("signing-key enrollment failed: HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(message)))
	}
	return nil
}

func tsnetHTTPClient(s *tsnet.Server) *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return s.Dial(ctx, network, address)
	}}}
}

func authKey(ctx context.Context, mode string, o Options) (string, error) {
	if o.EnrollmentID != "" || o.EnrollmentCode != "" {
		if (o.ManagementURL == "" && o.BootstrapURL == "") || o.EnrollmentID == "" || o.EnrollmentCode == "" {
			return "", errors.New("management or bootstrap URL, enrollment ID, and enrollment code are required")
		}
		exchangeURL := o.BootstrapURL
		if exchangeURL == "" {
			exchangeURL = o.ManagementURL
		}
		u, err := url.Parse(exchangeURL)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return "", errors.New("invalid management URL")
		}
		q := u.Query()
		q.Set("enrollment_id", o.EnrollmentID)
		q.Set("code", o.EnrollmentCode)
		u.Path = strings.TrimRight(u.Path, "/") + "/auth-keys/" + mode
		u.RawQuery = q.Encode()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), nil)
		if err != nil {
			return "", err
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return "", err
		}
		defer res.Body.Close()
		if res.StatusCode/100 != 2 {
			return "", fmt.Errorf("enrollment exchange failed: HTTP %d", res.StatusCode)
		}
		b, err := io.ReadAll(res.Body)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(b)), nil
	}
	if o.AuthKeyFile != "" {
		b, err := os.ReadFile(o.AuthKeyFile)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(b)), nil
	}
	if o.AuthKeyStdin {
		b, err := io.ReadAll(bufio.NewReader(os.Stdin))
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(b)), nil
	}
	if o.InteractiveLogin {
		return "", nil
	}
	return "", errors.New("a Tailscale auth key is required in non-interactive mode")
}

func joinTUI(_ context.Context, mode string, o Options) error {
	if runtime.GOOS == "windows" {
		return errors.New("interactive join is not supported on Windows")
	}
	m := joinModel{mode: mode}
	if _, err := tea.NewProgram(m).Run(); err != nil {
		return err
	}
	if m.path == "" {
		o.InteractiveLogin, o.NonInteractive = true, true
		return Join(context.Background(), mode, o)
	}
	o.AuthKeyFile, o.NonInteractive = m.path, true
	return Join(context.Background(), mode, o)
}

type joinModel struct {
	mode, path string
	screen     int
}

type runtimeStatus struct {
	Mode     string   `json:"mode"`
	Hostname string   `json:"hostname"`
	State    string   `json:"state"`
	IPs      []string `json:"ips"`
	Health   []string `json:"health,omitempty"`
}

func writeRuntimeStatus(dataDir string, status runtimeStatus) error {
	if err := os.WriteFile(filepath.Join(dataDir, "serve.pid"), []byte(fmt.Sprintf("%d", os.Getpid())), 0600); err != nil {
		return err
	}
	b, err := json.Marshal(status)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dataDir, "runtime-status.json"), b, 0600)
}

func processAlive(pid string) bool {
	var process *os.Process
	parsed := 0
	if _, err := fmt.Sscanf(strings.TrimSpace(pid), "%d", &parsed); err != nil || parsed <= 0 {
		return false
	}
	process, err := os.FindProcess(parsed)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}

func readRuntimeStatus(dataDir string) (runtimeStatus, bool) {
	pid, err := os.ReadFile(filepath.Join(dataDir, "serve.pid"))
	if err != nil || !processAlive(string(pid)) {
		return runtimeStatus{}, false
	}
	b, err := os.ReadFile(filepath.Join(dataDir, "runtime-status.json"))
	if err != nil {
		return runtimeStatus{}, false
	}
	var status runtimeStatus
	if json.Unmarshal(b, &status) != nil || status.Mode == "" {
		return runtimeStatus{}, false
	}
	return status, true
}

func (m joinModel) Init() tea.Cmd { return nil }
func (m joinModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case tea.KeyMsg:
		switch v.String() {
		case "ctrl+c", "q":
			return m, tea.Quit
		case "enter":
			if m.screen < 4 {
				m.screen++
				return m, nil
			}
			return m, tea.Quit
		case "backspace":
			if len(m.path) > 0 {
				m.path = m.path[:len(m.path)-1]
			}
		default:
			if len(v.Runes) > 0 {
				m.path += string(v.Runes)
			}
		}
	}
	return m, nil
}
func (m joinModel) View() string {
	switch m.screen {
	case 0:
		return fmt.Sprintf("Tailscale %s join · 1/5 Authentication\nEnter auth-key file path (or press Enter for interactive setup): %s\n\nPress Enter to continue, Ctrl-C to quit.\n", m.mode, m.path)
	case 1:
		return fmt.Sprintf("Tailscale %s join · 2/5 Defaults\nHostname: local machine default\nState path: platform config default\n\nPress Enter to continue, Ctrl-C to quit.\n", m.mode)
	case 2:
		return fmt.Sprintf("Tailscale %s join · 3/5 Review\nAuth-key file: %s\nHostname and paths use resolved defaults.\n\nPress Enter to connect, Ctrl-C to quit.\n", m.mode, m.path)
	case 3:
		return fmt.Sprintf("Tailscale %s join · 4/5 Connect\nThe node will join and persist its tsnet identity.\n\nPress Enter to continue, Ctrl-C to quit.\n", m.mode)
	default:
		return fmt.Sprintf("Tailscale %s join · 5/5 Complete\nThe node is ready to start control serve.\n\nPress Enter to exit, Ctrl-C to quit.\n", m.mode)
	}
}

func Serve(ctx context.Context, mode string, o Options) error {
	var err error
	o, err = defaults(mode, o)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(o.DataDir, 0700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(o.DataDir, "hostname"), []byte(o.Hostname), 0600); err != nil {
		return err
	}
	if o.ManagementURL == "" {
		if b, readErr := os.ReadFile(filepath.Join(o.DataDir, "management-url")); readErr == nil {
			o.ManagementURL = strings.TrimSpace(string(b))
		}
	}
	st, err := store.Open(o.DataDir)
	if err != nil {
		return err
	}
	defer st.Close()
	s := &tsnet.Server{Hostname: o.Hostname, Dir: o.StateDir}
	if key, readErr := os.ReadFile(filepath.Join(o.StateDir, "authkey")); readErr == nil {
		s.AuthKey = strings.TrimSpace(string(key))
	}
	if _, err := s.Up(ctx); err != nil {
		return fmt.Errorf("start tsnet: %w", err)
	}
	defer s.Close()
	if local, localErr := s.LocalClient(); localErr == nil {
		if current, statusErr := local.StatusWithoutPeers(ctx); statusErr == nil {
			ips := make([]string, 0, len(current.TailscaleIPs))
			for _, ip := range current.TailscaleIPs {
				ips = append(ips, ip.String())
			}
			_ = writeRuntimeStatus(o.DataDir, runtimeStatus{Mode: mode, Hostname: o.Hostname, State: current.BackendState, IPs: ips, Health: current.Health})
		}
	}
	defer os.Remove(filepath.Join(o.DataDir, "serve.pid"))
	if mode != "control" {
		// Reports need the router's stable tailnet address as their backend A
		// target. Derive it from the same persistent tsnet identity used by the
		// proxy unless the operator explicitly supplied --tailscale-ip.
		if o.TailscaleIP == "" {
			if local, localErr := s.LocalClient(); localErr == nil {
				if status, statusErr := local.StatusWithoutPeers(ctx); statusErr == nil && len(status.TailscaleIPs) > 0 {
					o.TailscaleIP = status.TailscaleIPs[0].String()
				}
			}
		}
		// The embedded proxy reads these values when constructing its Caddy and
		// tsnet configuration. Keep CLI paths and identity names authoritative.
		_ = os.Setenv("FUNNEL_STATE_DIR", o.StateDir)
		_ = os.Setenv("FUNNEL_HOSTNAME", o.Hostname)
		_ = os.Setenv("FUNNEL_DATA_DIR", o.DataDir)
		setEnvIfPresent("FUNNEL_MANAGEMENT_URL", o.ManagementURL)
		setEnvIfPresent("FUNNEL_GATEWAY_HOSTNAME", o.GatewayHostname)
		setEnvIfPresent("FUNNEL_TAILSCALE_IP", o.TailscaleIP)
		setEnvIfPresent("FUNNEL_INGRESS_NETWORK", o.IngressNetwork)
		if mode == "router" {
			if os.Getenv("FUNNEL_ROUTER_PORT") == "" {
				_ = os.Setenv("FUNNEL_ROUTER_PORT", "18080")
			}
		}
		if nodeID, readErr := os.ReadFile(filepath.Join(o.DataDir, "node-id")); readErr == nil {
			_ = os.Setenv("FUNNEL_NODE_ID", strings.TrimSpace(string(nodeID)))
		}
		// Caddy follows the XDG data/config locations. Point it at the
		// selected mode's writable data directory so certificates and config
		// survive restarts without requiring a container filesystem layout.
		_ = os.Setenv("XDG_DATA_HOME", o.DataDir)
		_ = os.Setenv("XDG_CONFIG_HOME", filepath.Join(o.DataDir, "config"))
		if o.CertEmail != "" {
			_ = os.Setenv("FUNNEL_CERT_EMAIL", o.CertEmail)
		}
		if err := proxy.Start(mode, o.Listen, s.Dial); err != nil {
			return err
		}
		if mode == "router" {
			// caddy-docker-proxy listens on the container's HTTP port. Bridge
			// that listener to the same router's tsnet identity so the gateway
			// can reach it without a second Tailscale node or TUN device.
			listener, listenErr := s.Listen("tcp", ":18080")
			if listenErr != nil {
				return fmt.Errorf("listen on router tailnet: %w", listenErr)
			}
			upstream, parseErr := url.Parse("http://127.0.0.1:80")
			if parseErr != nil {
				return parseErr
			}
			bridge := httputil.NewSingleHostReverseProxy(upstream)
			go func() {
				if serveErr := (&http.Server{Handler: bridge}).Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
					slog.Error("router tailnet bridge stopped", "error", serveErr)
				}
			}()
		}
		<-ctx.Done()
		return nil
	}
	ln, err := s.Listen("tcp", o.Listen)
	if err != nil {
		return err
	}
	defer ln.Close()
	control := &web.Control{Store: st}
	h := control.Handler()
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				_, _ = control.ExpireReports(context.Background(), 5*time.Minute)
			case <-ctx.Done():
				return
			}
		}
	}()
	localClient, err := s.LocalClient()
	if err != nil {
		return err
	}
	identityHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		who, err := localClient.WhoIs(r.Context(), r.RemoteAddr)
		if err != nil {
			http.Error(w, "tailnet identity required", http.StatusForbidden)
			return
		}
		identity := ""
		if who.Node != nil {
			identity = who.Node.Name
		}
		p := web.Principal{Hostname: identity, Capabilities: map[string][]json.RawMessage{}}
		for capability, values := range who.CapMap {
			for _, value := range values {
				p.Capabilities[string(capability)] = append(p.Capabilities[string(capability)], json.RawMessage(value))
			}
		}
		if who.Node != nil {
			p.NodeID = string(who.Node.StableID)
			p.Tagged = len(who.Node.Tags) > 0
			p.Tags = append(p.Tags, who.Node.Tags...)
			for _, addr := range who.Node.Addresses {
				p.Addresses = append(p.Addresses, addr.String())
			}
		}
		if who.UserProfile != nil {
			p.Login = who.UserProfile.LoginName
			p.Groups = append(p.Groups, who.UserProfile.Groups...)
		}
		slog.Info("tailnet request identity", "remote", r.RemoteAddr, "node_id", p.NodeID, "hostname", p.Hostname, "login", p.Login, "groups", p.Groups, "tags", p.Tags)
		h.ServeHTTP(w, web.WithPrincipal(web.WithIdentity(r, identity), p))
	})
	server := &http.Server{Handler: identityHandler}
	go func() { <-ctx.Done(); _ = server.Shutdown(context.Background()) }()
	if o.BootstrapListen != "" {
		bootstrap := &http.Server{Addr: o.BootstrapListen, Handler: control.BootstrapHandler()}
		go func() {
			<-ctx.Done()
			_ = bootstrap.Shutdown(context.Background())
		}()
		go func() { _ = bootstrap.ListenAndServe() }()
		fmt.Printf("enrollment bootstrap listening on %s\n", o.BootstrapListen)
	}
	fmt.Printf("control listening on tailnet %s\n", o.Listen)
	return server.Serve(ln)
}

func setEnvIfPresent(name, value string) {
	if strings.TrimSpace(value) != "" {
		_ = os.Setenv(name, value)
	}
}
func Status(mode string, o Options) error {
	explicitHostname := strings.TrimSpace(o.Hostname)
	o, err := defaults(mode, o)
	if err != nil {
		return err
	}
	if explicitHostname == "" {
		if b, readErr := os.ReadFile(filepath.Join(o.DataDir, "hostname")); readErr == nil && strings.TrimSpace(string(b)) != "" {
			o.Hostname = strings.TrimSpace(string(b))
		}
	}
	if current, ok := readRuntimeStatus(o.DataDir); ok {
		fmt.Printf("mode: %s\nhostname: %s\nstate: %s\nips: %v\nstate_dir: %s\ndata_dir: %s\n", current.Mode, current.Hostname, current.State, current.IPs, o.StateDir, o.DataDir)
		printStoredNode(o.DataDir)
		if len(current.Health) > 0 {
			fmt.Printf("health: %s\n", strings.Join(current.Health, "; "))
		} else {
			fmt.Println("health: ok")
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	s := &tsnet.Server{Hostname: o.Hostname, Dir: o.StateDir}
	if key, readErr := os.ReadFile(filepath.Join(o.StateDir, "authkey")); readErr == nil {
		s.AuthKey = strings.TrimSpace(string(key))
	}
	if _, err := s.Up(ctx); err != nil {
		return fmt.Errorf("status: tsnet unavailable: %w", err)
	}
	defer s.Close()
	lc, err := s.LocalClient()
	if err != nil {
		return err
	}
	status, err := lc.StatusWithoutPeers(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("mode: %s\nhostname: %s\nstate: %s\nips: %v\nstate_dir: %s\ndata_dir: %s\n", mode, o.Hostname, status.BackendState, status.TailscaleIPs, o.StateDir, o.DataDir)
	printStoredNode(o.DataDir)
	if len(status.Health) > 0 {
		fmt.Printf("health: %s\n", strings.Join(status.Health, "; "))
	} else {
		fmt.Println("health: ok")
	}
	return nil
}

func printStoredNode(dataDir string) {
	nodeIDBytes, readErr := os.ReadFile(filepath.Join(dataDir, "node-id"))
	if readErr != nil {
		return
	}
	st, storeErr := store.Open(dataDir)
	if storeErr != nil {
		return
	}
	defer st.Close()
	if node, nodeErr := st.Node(strings.TrimSpace(string(nodeIDBytes))); nodeErr == nil {
		fmt.Printf("node_id: %s\nnode_mode: %s\nnode_hostname: %s\nlast_report: %d\nrevoked: %t\n", node.ID, node.Mode, node.Hostname, node.LastReport, node.Revoked)
	}
}
func Reset(mode string, o Options) error {
	o, err := defaults(mode, o)
	if err != nil {
		return err
	}
	if !o.Force {
		return errors.New("reset requires --force")
	}
	if err := os.RemoveAll(o.StateDir); err != nil {
		return err
	}
	if err := os.RemoveAll(o.DataDir); err != nil {
		return err
	}
	fmt.Printf("removed local %s state and data; revoke the node or enrollment in the control UI if it is still registered\n", mode)
	return nil
}
