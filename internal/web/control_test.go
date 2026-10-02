package web

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tailscale-x/tailscale-private-funnel/internal/policy"
	"github.com/tailscale-x/tailscale-private-funnel/internal/report"
	"github.com/tailscale-x/tailscale-private-funnel/internal/store"
)

func TestSignedReportRequiresBoundTailnetIdentityAndRejectsReplay(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	pub, priv, err := report.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertNodeEnrollment("node-1", "enrollment-1", "router", "router-one"); err != nil {
		t.Fatal(err)
	}
	if err := s.BindNodeIdentity("node-1", encodePublicKey(pub), "tailnode-1", []string{"100.64.0.5"}); err != nil {
		t.Fatal(err)
	}
	e, err := report.NewEnvelope("node-1", map[string]any{"exposures": []any{}, "expires_at": time.Now().Add(time.Minute).Unix()}, pub, priv, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(e)
	h := (&Control{Store: s}).Handler()
	request := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/reports", bytes.NewReader(body))
		r = WithPrincipal(r, Principal{NodeID: "tailnode-1", Hostname: "router-one", Addresses: []string{"100.64.0.5"}})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	first := request()
	if got := first.Code; got != http.StatusAccepted {
		t.Fatalf("first report status=%d body=%s", got, first.Body.String())
	}
	if got := request().Code; got != http.StatusConflict {
		t.Fatalf("replay status=%d", got)
	}
}

func TestRouterReportRequiresHostnamePolicy(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	pub, priv, err := report.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertNodeEnrollment("node-policy", "enrollment-policy", "router", "router-policy"); err != nil {
		t.Fatal(err)
	}
	if err := s.BindNodeIdentity("node-policy", encodePublicKey(pub), "tailnode-policy", []string{"100.64.0.5"}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetJSON("exposure_policy", policy.Document{Rules: []policy.Rule{{Name: "dev", HostnameRegex: `[^.]+\.dev\.example\.com`, Roles: []string{"tag:router-dev"}, Enabled: true}}}); err != nil {
		t.Fatal(err)
	}
	reportBody := func(host string) []byte {
		e, envelopeErr := report.NewEnvelope("node-policy", map[string]any{
			"exposures":  []map[string]any{{"public_hostname": host, "backend_hostname": "router-policy", "backend_ip": "100.64.0.5", "gateway_hostname": "gateway.example.com", "port": 18080}},
			"expires_at": time.Now().Add(time.Minute).Unix(),
		}, pub, priv, time.Now())
		if envelopeErr != nil {
			t.Fatal(envelopeErr)
		}
		body, _ := json.Marshal(e)
		return body
	}
	h := (&Control{Store: s}).Handler()
	request := func(host string, tags []string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/reports", bytes.NewReader(reportBody(host)))
		r = WithPrincipal(r, Principal{NodeID: "tailnode-policy", Hostname: "router-policy", Tags: tags, Addresses: []string{"100.64.0.5"}})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if got := request("app.dev.example.com", []string{"tag:router-dev"}).Code; got != http.StatusAccepted {
		t.Fatalf("allowed report status=%d", got)
	}
	if got := request("app.prod.example.com", []string{"tag:router-dev"}).Code; got != http.StatusForbidden {
		t.Fatalf("hostname policy status=%d", got)
	}
}

func TestEnrollmentCommandsUseConfiguredImageAndWritableBindDirs(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.SetJSON("tailnet", map[string]any{
		"name":            "example.ts.net",
		"tags":            "tag:router",
		"management_url":  "http://100.64.0.10:8080",
		"bootstrap_url":   "http://control-bootstrap:8081",
		"image":           "ghcr.io/example/funnel:test",
		"ingress_network": "funnel-ingress",
	}); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/enrollments/router", bytes.NewBufferString(`{"hostname":"router-test"}`))
	r.Header.Set("Content-Type", "application/json")
	r = WithPrincipal(r, Principal{NodeID: "admin-node", Login: "admin@example.com"})
	w := httptest.NewRecorder()
	(&Control{Store: s}).Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var response struct {
		DockerJoin  string `json:"docker_join"`
		DockerServe string `json:"docker_serve"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{response.DockerJoin, response.DockerServe} {
		if !strings.Contains(command, "mkdir -p router-state router-data") || !strings.Contains(command, `--user "$(id -u):$(id -g)"`) || !strings.Contains(command, "ghcr.io/example/funnel:test") {
			t.Fatalf("command does not preserve writable bind paths and image: %s", command)
		}
	}
}

func TestDeploymentSettingsDoNotClearOAuthCredentials(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.SetSecret("tailscale_oauth_client_id", "client-id"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSecret("tailscale_oauth_client_secret", "client-secret"); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/settings", strings.NewReader("image=ghcr.io/example/funnel:v1.0.0&gateway_hostname=gateway.example.com"))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r = WithPrincipal(r, Principal{NodeID: "admin-node", Login: "admin@example.com"})
	w := httptest.NewRecorder()
	(&Control{Store: s}).Handler().ServeHTTP(w, r)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("settings status=%d body=%s", w.Code, w.Body.String())
	}
	for key, want := range map[string]string{
		"tailscale_oauth_client_id":     "client-id",
		"tailscale_oauth_client_secret": "client-secret",
	} {
		got, getErr := s.GetSecret(key)
		if getErr != nil || got != want {
			t.Fatalf("%s changed after deployment settings: got=%q err=%v", key, got, getErr)
		}
	}
}

func TestManagementAuthorizationUsesTailscaleRoles(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.SetJSON("tailnet", map[string]any{
		"name": "example.ts.net", "tags": "tag:router", "management_url": "http://100.64.0.10:8080", "bootstrap_url": "http://control-bootstrap:8081",
		"roles": map[string][]string{"admin": {"group:platform-admins"}, "viewer": {"group:readonly"}},
	}); err != nil {
		t.Fatal(err)
	}
	h := (&Control{Store: s}).Handler()
	request := func(groups []string) int {
		r := httptest.NewRequest(http.MethodPost, "/api/enrollments/router", bytes.NewBufferString(`{"hostname":"router-role"}`))
		r.Header.Set("Content-Type", "application/json")
		r = WithPrincipal(r, Principal{NodeID: "admin-node", Login: "member@example.com", Groups: groups})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if got := request([]string{"group:readonly"}); got != http.StatusForbidden {
		t.Fatalf("viewer should not create enrollments: status=%d", got)
	}
	if got := request([]string{"group:platform-admins"}); got != http.StatusOK {
		t.Fatalf("admin group should create enrollments: status=%d", got)
	}
}

func TestTaggedNodeDoesNotInheritCreatorAndCapabilityCanGrantRole(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.SetJSON("access_roles", map[string]any{
		"admins":     []string{"owner@example.com"},
		"roles":      map[string][]string{},
		"capability": DefaultCapability,
	}); err != nil {
		t.Fatal(err)
	}
	h := (&Control{Store: s}).Handler()
	request := func(p Principal) int {
		r := httptest.NewRequest(http.MethodGet, "/settings", nil)
		r = WithPrincipal(r, p)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if got := request(Principal{NodeID: "tagged-node", Login: "owner@example.com", Tagged: true, Tags: []string{"tag:router"}}); got != http.StatusForbidden {
		t.Fatalf("tagged node inherited creator access: status=%d", got)
	}
	if got := request(Principal{NodeID: "cap-node", Tagged: true, Tags: []string{"tag:router"}, Capabilities: map[string][]json.RawMessage{DefaultCapability: {json.RawMessage(`{"roles":["admin"]}`)}}}); got != http.StatusOK {
		t.Fatalf("capability admin should authorize: status=%d", got)
	}
}

func TestManualRouterExposureIsDeniedByDefaultPolicy(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h := (&Control{Store: s}).Handler()
	body := bytes.NewBufferString(`{"kind":"router","provider_id":"missing","owner_id":"router-1","public_hostname":"app.dev.example.com","backend_hostname":"router-1","backend_ip":"100.64.0.5","gateway_hostname":"gateway.example.com","port":18080}`)
	r := httptest.NewRequest(http.MethodPost, "/api/exposures/sync", body)
	r.Header.Set("Content-Type", "application/json")
	r = WithPrincipal(r, Principal{NodeID: "admin-node", Login: "admin@example.com"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("empty policy should deny manual exposure: status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestEnrollmentPageExplainsGeneratedCommands(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h := (&Control{Store: s}).Handler()
	r := httptest.NewRequest(http.MethodGet, "/enroll/router", nil)
	r = WithPrincipal(r, Principal{NodeID: "admin-node", Login: "admin@example.com"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("enrollment page status=%d body=%s", w.Code, w.Body.String())
	}
	for _, text := range []string{"Router enrollment", "Docker join:", "Docker serve:", "Exposure policy:"} {
		if !strings.Contains(w.Body.String(), text) {
			t.Fatalf("enrollment page missing %q", text)
		}
	}
}

func TestRedesignedPagesRenderSharedShellForAdministrator(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.SetJSON("access_roles", map[string]any{"admins": []string{"admin@example.com"}, "roles": map[string][]string{}, "capability": DefaultCapability}); err != nil {
		t.Fatal(err)
	}
	h := (&Control{Store: s}).Handler()
	for _, path := range []string{"/", "/settings", "/access", "/providers", "/zones", "/gateways", "/routers", "/policies", "/exposures", "/operations", "/enroll/gateway", "/enroll/router"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r = WithPrincipal(r, Principal{NodeID: "admin-node", Login: "admin@example.com"})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", path, w.Code, w.Body.String())
		}
		body := w.Body.String()
		if !strings.Contains(body, `class="pf-app"`) || !strings.Contains(body, `aria-label="Primary navigation"`) {
			t.Fatalf("%s missing shared shell", path)
		}
	}
}

func TestPolicyRuleEditorPersistsGuidedRule(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h := (&Control{Store: s}).Handler()
	r := httptest.NewRequest(http.MethodPost, "/api/policies/rule", strings.NewReader("name=dev&hostname_regex=%5B%5E.%5D%2B%5C.dev%5C.example%5C.com&roles=tag%3Arouter-dev&gateway_hostnames=gateway.example.com&enabled=on"))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.Header.Set("HX-Request", "true")
	r = WithPrincipal(r, Principal{NodeID: "admin-node", Login: "admin@example.com"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("rule status=%d body=%s", w.Code, w.Body.String())
	}
	document := (&Control{Store: s}).loadExposurePolicy()
	if len(document.Rules) != 1 || document.Rules[0].Name != "dev" {
		t.Fatalf("guided rule not persisted: %#v", document)
	}
}

func encodePublicKey(key []byte) string {
	return base64.RawStdEncoding.EncodeToString(key)
}
