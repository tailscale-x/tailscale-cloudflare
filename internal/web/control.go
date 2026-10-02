package web

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/libdns/libdns"
	"github.com/tailscale-x/tailscale-private-funnel/internal/dns"
	"github.com/tailscale-x/tailscale-private-funnel/internal/policy"
	"github.com/tailscale-x/tailscale-private-funnel/internal/report"
	"github.com/tailscale-x/tailscale-private-funnel/internal/store"
	"github.com/tailscale-x/tailscale-private-funnel/internal/tailscale"
	"github.com/tailscale-x/tailscale-private-funnel/internal/web/ui"
	"html/template"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"time"
)

type Control struct {
	Store     *store.Store
	syncMu    sync.Mutex
	accessMu  sync.Mutex
	ReportTTL time.Duration
}

type Principal struct {
	NodeID       string
	Hostname     string
	Login        string
	Addresses    []string
	Groups       []string
	Tags         []string
	Tagged       bool
	Capabilities map[string][]json.RawMessage
}
type principalKey struct{}

func WithPrincipal(r *http.Request, p Principal) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), principalKey{}, p))
}
func principal(r *http.Request) Principal {
	p, _ := r.Context().Value(principalKey{}).(Principal)
	return p
}

type identityContextKey struct{}

func WithIdentity(r *http.Request, identity string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), identityContextKey{}, identity))
}

func identityFromRequest(r *http.Request) string {
	value, _ := r.Context().Value(identityContextKey{}).(string)
	return value
}

// RoleSelectors exposes the stable Tailscale identity values that can be used
// by both UI authorization and router exposure policy. Groups are supplied by
// WhoIs, while tags are supplied by the node identity.
func (p Principal) RoleSelectors() []string {
	seen := map[string]bool{}
	var out []string
	add := func(value string) {
		value = strings.ToLower(strings.TrimSpace(value))
		if value != "" && !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	if !p.Tagged && len(p.Tags) == 0 {
		add(p.Login)
		if p.Login != "" {
			add("user:" + p.Login)
		}
		for _, group := range p.Groups {
			add(group)
			if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(group)), "group:") {
				add("group:" + group)
			}
		}
	}
	if p.NodeID != "" {
		add("node:" + p.NodeID)
	}
	for _, tag := range p.Tags {
		add(tag)
		if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(tag)), "tag:") {
			add("tag:" + tag)
		}
	}
	return out
}

func selectorMatches(p Principal, selector string) bool {
	if strings.HasPrefix(strings.TrimSpace(selector), "node:") {
		return p.NodeID != "" && strings.TrimPrefix(strings.TrimSpace(selector), "node:") == p.NodeID
	}
	selector = strings.ToLower(strings.TrimSpace(selector))
	if selector == "*" {
		return true
	}
	for _, value := range p.RoleSelectors() {
		if selector == value {
			return true
		}
	}
	return false
}

func roleConfigured(roles map[string][]string) bool {
	for _, values := range roles {
		if len(values) > 0 {
			return true
		}
	}
	return false
}

func hasRole(p Principal, roles map[string][]string, role string) bool {
	for _, selector := range roles[strings.ToLower(role)] {
		if selectorMatches(p, selector) {
			return true
		}
	}
	return false
}

func exactAdmin(p Principal, admins []string) bool {
	for _, admin := range admins {
		admin = strings.TrimSpace(admin)
		if admin != "" && (admin == p.NodeID || selectorMatches(p, admin)) {
			return true
		}
	}
	return false
}

func requiredAccess(req *http.Request) string {
	if req.Method == http.MethodGet || req.Method == http.MethodHead {
		return "viewer"
	}
	path := req.URL.Path
	if strings.HasPrefix(path, "/api/sync") || strings.HasPrefix(path, "/api/exposures/sync") || path == "/operations/sync" || path == "/api/reports/expire" {
		return "operator"
	}
	return "admin"
}

func (c *Control) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(c.authorize)
	assetFS, _ := fs.Sub(Assets, "assets")
	r.Handle("/assets/*", http.StripPrefix("/assets/", http.FileServer(http.FS(assetFS))))
	r.Get("/", c.dashboard)
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	r.Get("/settings", c.settings)
	r.Post("/settings", c.saveSettings)
	r.Post("/api/settings/bootstrap", c.saveBootstrap)
	r.Post("/api/settings/deployment", c.saveDeployment)
	r.Get("/providers", c.providers)
	r.Get("/api/providers", c.providerList)
	r.Post("/api/providers", c.providerSave)
	r.Post("/api/providers/{id}/test", c.providerTest)
	r.Post("/api/providers/{id}/enable", c.providerEnable)
	r.Delete("/api/providers/{id}", c.providerDelete)
	r.Get("/zones", c.zones)
	r.Get("/api/zones", c.zoneList)
	r.Post("/api/zones", c.zoneSave)
	r.Post("/api/sync", c.sync)
	r.Post("/api/exposures/sync", c.exposureSync)
	r.Get("/operations", c.operations)
	r.Post("/operations/sync", c.operationsSync)
	r.Get("/access", c.accessPage)
	r.Get("/api/access", c.accessGet)
	r.Post("/api/access", c.accessSave)
	r.Get("/policies", c.policies)
	r.Get("/api/policies", c.policyGet)
	r.Post("/api/policies", c.policySave)
	r.Post("/api/policies/rule", c.policyRuleSave)
	r.Post("/api/policies/test", c.policyTest)
	r.Get("/api/reports", c.reports)
	r.Post("/api/reports", c.saveReport)
	r.Get("/api/audit", c.audit)
	r.Post("/api/reports/expire", c.expireReports)
	r.Post("/auth-keys/{mode}", c.authKey)
	r.Post("/api/enrollments/{mode}", c.enrollmentCreate)
	r.Get("/api/enrollments/{mode}", c.enrollmentList)
	r.Post("/api/enrollments/{id}/revoke", c.enrollmentRevoke)
	r.Post("/api/enrollments/{id}/signing-key", c.enrollmentSigningKey)
	r.Get("/gateways", c.nodes)
	r.Get("/routers", c.nodes)
	r.Get("/exposures", c.exposures)
	r.Get("/api/nodes/{mode}", c.nodeList)
	r.Post("/api/nodes/{id}/revoke", c.nodeRevoke)
	r.Get("/enroll/{mode}", c.enroll)
	return r
}

// BootstrapHandler intentionally exposes only code-protected enrollment
// redemption. All management and DNS APIs remain behind the tailnet handler.
func (c *Control) BootstrapHandler() http.Handler {
	r := chi.NewRouter()
	r.Post("/auth-keys/{mode}", c.authKey)
	// The installer has not joined the tailnet until after the auth-key
	// exchange. The enrollment code also protects the signing-key bind, so the
	// bootstrap listener can complete the transaction without exposing the
	// management API.
	return r
}
func (c *Control) dashboard(w http.ResponseWriter, r *http.Request) {
	providers, _ := c.Store.Providers()
	gateways, _ := c.Store.Nodes("gateway")
	routers, _ := c.Store.Nodes("router")
	reports, _ := c.Store.Reports()
	audit, _ := c.Store.AuditEvents(6)
	zones, _ := c.Store.Zones()
	var tailnet struct {
		Name string `json:"name"`
	}
	_ = c.Store.GetJSON("tailnet", &tailnet)
	exposureCount := reportExposureCount(reports)
	nextTitle, nextCopy, nextHref := "Configure your first DNS provider", "Connect a provider so the control plane can reconcile owned records.", "/providers"
	if len(providers) > 0 {
		nextTitle, nextCopy, nextHref = "Create a gateway", "The gateway is the public edge for your tailnet services.", "/enroll/gateway"
	}
	if len(gateways) > 0 {
		nextTitle, nextCopy, nextHref = "Add an exposure policy", "Policies keep router hostnames scoped to the right node and domain.", "/policies"
	}
	if len(routers) > 0 {
		nextTitle, nextCopy, nextHref = "Review router exposures", "Inspect the latest signed reports and publish only approved routes.", "/exposures"
	}
	var b strings.Builder
	b.WriteString(pageIntro("Control plane", "Dashboard", "A calm view of your private edge. Follow the topology from control to gateway, router, and the services you have approved."))
	b.WriteString(`<div class="pf-stat-grid">`)
	fmt.Fprintf(&b, `<a class="pf-stat" href="/gateways"><span class="pf-stat-top"><span class="pf-stat-label">Gateways</span>%s</span><strong class="pf-stat-value">%d</strong><span class="pf-stat-note">public edge nodes</span></a>`, pill("Healthy", "ok"), len(gateways))
	fmt.Fprintf(&b, `<a class="pf-stat" href="/routers"><span class="pf-stat-top"><span class="pf-stat-label">Routers</span>%s</span><strong class="pf-stat-value">%d</strong><span class="pf-stat-note">reporting nodes</span></a>`, pill("Monitored", "ok"), len(routers))
	fmt.Fprintf(&b, `<a class="pf-stat" href="/exposures"><span class="pf-stat-top"><span class="pf-stat-label">Exposures</span>%s</span><strong class="pf-stat-value">%d</strong><span class="pf-stat-note">policy-scoped routes</span></a>`, pill("Owned", "ok"), exposureCount)
	fmt.Fprintf(&b, `<a class="pf-stat" href="/providers"><span class="pf-stat-top"><span class="pf-stat-label">DNS providers</span>%s</span><strong class="pf-stat-value">%d</strong><span class="pf-stat-note">%d managed zones</span></a>`, pill("Encrypted", "ok"), len(providers), len(zones))
	b.WriteString(`</div><div class="pf-dashboard-grid"><section class="pf-surface pf-topology"><div class="pf-section-heading"><div><p class="pf-kicker">Live topology</p><h2>How traffic moves</h2></div><a class="pf-text-link" href="/exposures">View exposures <span aria-hidden="true">→</span></a></div><div class="pf-topology-flow"><div class="pf-topology-node"><img src="/assets/icons/shield-check.svg" alt="" class="pf-icon"><strong>Control plane</strong><small>policy + DNS ownership</small><span class="pf-node-state">` + safeText(tailnet.Name) + `</span></div><span class="pf-topology-connector" aria-hidden="true">→</span><div class="pf-topology-node"><img src="/assets/icons/server-2.svg" alt="" class="pf-icon"><strong>Gateways</strong><small>public TLS edge</small><span class="pf-node-state">` + fmt.Sprintf("%d nodes", len(gateways)) + `</span></div><span class="pf-topology-connector" aria-hidden="true">→</span><div class="pf-topology-node"><img src="/assets/icons/route.svg" alt="" class="pf-icon"><strong>Routers</strong><small>tailnet backends</small><span class="pf-node-state">` + fmt.Sprintf("%d reporting", len(routers)) + `</span></div><span class="pf-topology-connector" aria-hidden="true">→</span><div class="pf-topology-node"><img src="/assets/icons/world.svg" alt="" class="pf-icon"><strong>Exposures</strong><small>approved hostnames</small><span class="pf-node-state">` + fmt.Sprintf("%d active", exposureCount) + `</span></div></div></section><aside class="pf-surface pf-next-step"><p class="pf-kicker">Next step</p><h2>` + safeText(nextTitle) + `</h2><p>` + safeText(nextCopy) + `</p><a class="pf-button" href="` + safeText(nextHref) + `">Open next step <span aria-hidden="true">→</span></a><div class="pf-next-meta"><span class="pf-status-dot pf-status-ok"></span><span>Changes stay within your ownership ledger.</span></div></aside></div>`)
	b.WriteString(`<div class="pf-dashboard-lower"><section class="pf-surface"><div class="pf-section-heading"><div><p class="pf-kicker">Recent activity</p><h2>Audit events</h2></div><a class="pf-text-link" href="/api/audit">View all</a></div>`)
	if len(audit) == 0 {
		b.WriteString(`<div class="pf-empty"><strong>No events yet</strong><span>Mutations and policy decisions will appear here.</span></div>`)
	} else {
		b.WriteString(`<div class="pf-event-list">`)
		for _, event := range audit {
			fmt.Fprintf(&b, `<div class="pf-event"><span class="pf-event-icon"><img src="/assets/icons/activity.svg" alt=""></span><span><strong>%s</strong><small>%s · %s</small></span></div>`, safeText(event.Action), safeText(event.Actor), safeText(unixLabel(event.CreatedAt)))
		}
		b.WriteString(`</div>`)
	}
	b.WriteString(`</section><section class="pf-surface pf-status-card"><div class="pf-section-heading"><div><p class="pf-kicker">Control health</p><h2>Tailnet status</h2></div><span class="pf-health-label"><i class="pf-status-dot pf-status-ok"></i> Operational</span></div><div class="pf-status-row"><span>Tailnet</span><strong class="font-mono">` + safeText(tailnet.Name) + `</strong></div><div class="pf-status-row"><span>DNS sync</span><strong>` + pill("Ownership enforced", "ok") + `</strong></div><div class="pf-status-row"><span>Last report</span><strong>` + safeText(unixLabel(time.Now().Unix())) + `</strong></div><a class="pf-secondary-button" href="/operations">Open operations <span aria-hidden="true">→</span></a></section></div>`)
	render(w, "Dashboard", b.String())
}
func (c *Control) settings(w http.ResponseWriter, _ *http.Request) {
	render(w, "Tailscale", pageIntro("Access", "Tailscale settings", "Connect the control node to your tailnet and choose the deployment values used by generated gateway and router commands.")+`<div class="pf-alert pf-alert-info"><strong>Tailnet-only management.</strong> OAuth secrets are stored encrypted and are never returned by the UI or included in installer commands.</div><section class="pf-surface pf-form-surface"><div class="pf-section-heading"><div><p class="pf-kicker">Identity and enrollment</p><h2>Tailnet connection</h2></div><a class="pf-text-link" href="/access">Configure access roles <span aria-hidden="true">→</span></a></div><form method="post" class="pf-form-grid" hx-post="/settings" hx-target="#result"><label class="pf-field"><span class="pf-label">Tailnet</span><input class="pf-input" required name="tailnet" placeholder="example.ts.net"></label><label class="pf-field"><span class="pf-label">Auth-key tags</span><input class="pf-input" required name="tags" placeholder="tag:server,tag:gateway"></label><label class="pf-field"><span class="pf-label">Management URL</span><input class="pf-input" name="management_url" placeholder="http://100.x.y.z:8080"></label><label class="pf-field"><span class="pf-label">Enrollment bootstrap URL</span><input class="pf-input" name="bootstrap_url" placeholder="http://control-vps:8081"></label><label class="pf-field"><span class="pf-label">OAuth client ID</span><input class="pf-input" required name="client_id"></label><label class="pf-field"><span class="pf-label">OAuth client secret</span><input class="pf-input" required type="password" name="client_secret"></label><div class="pf-form-actions"><button class="pf-button" type="submit">Save tailnet settings <span aria-hidden="true">→</span></button><span id="result" class="pf-inline-result" role="status"></span></div></form></section><section class="pf-surface pf-form-surface"><div class="pf-section-heading"><div><p class="pf-kicker">Deployment defaults</p><h2>Generated command values</h2></div></div><form method="post" class="pf-form-grid" hx-post="/settings" hx-target="#result"><label class="pf-field"><span class="pf-label">Release image</span><input class="pf-input font-mono" name="image" placeholder="ghcr.io/tailscale-x/tailscale-private-funnel:v1.0.0"></label><label class="pf-field"><span class="pf-label">Gateway hostname</span><input class="pf-input" name="gateway_hostname" placeholder="gateway.example.com"></label><label class="pf-field"><span class="pf-label">Certificate email</span><input class="pf-input" type="email" name="cert_email" placeholder="ops@example.com"></label><label class="pf-field"><span class="pf-label">Router ingress network</span><input class="pf-input" name="ingress_network" placeholder="private-funnel-ingress"></label><div class="pf-form-actions"><button class="pf-secondary-button" type="submit">Save deployment values</button></div></form></section>`)
}
func (c *Control) saveSettings(w http.ResponseWriter, r *http.Request) {
	var admins []string
	for _, admin := range strings.Split(r.FormValue("admins"), ",") {
		if admin = strings.TrimSpace(admin); admin != "" {
			admins = append(admins, admin)
		}
	}
	roles := map[string][]string{}
	for _, role := range []string{"admin", "operator", "viewer"} {
		for _, selector := range strings.Split(r.FormValue("role_"+role), ",") {
			if selector = strings.TrimSpace(selector); selector != "" {
				roles[role] = append(roles[role], selector)
			}
		}
	}
	settings := map[string]any{}
	_ = c.Store.GetJSON("tailnet", &settings)
	for key, value := range map[string]string{"name": r.FormValue("tailnet"), "tags": r.FormValue("tags"), "management_url": r.FormValue("management_url"), "image": r.FormValue("image"), "bootstrap_url": r.FormValue("bootstrap_url"), "gateway_hostname": r.FormValue("gateway_hostname"), "cert_email": r.FormValue("cert_email"), "ingress_network": r.FormValue("ingress_network")} {
		if strings.TrimSpace(value) != "" {
			settings[key] = strings.TrimSpace(value)
		}
	}
	if len(admins) > 0 {
		settings["admins"] = admins
	}
	if len(roles) > 0 {
		settings["roles"] = roles
	}
	if err := c.Store.SetJSON("tailnet", settings); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if err := c.Store.SetSecret("tailscale_oauth_client_id", strings.TrimSpace(r.FormValue("client_id"))); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if err := c.Store.SetSecret("tailscale_oauth_client_secret", strings.TrimSpace(r.FormValue("client_secret"))); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if r.Header.Get("HX-Request") == "true" {
		_, _ = w.Write([]byte("Saved."))
		return
	}
	http.Redirect(w, r, "/settings", http.StatusSeeOther)
}

func (c *Control) saveBootstrap(w http.ResponseWriter, r *http.Request) {
	var input struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&input); err != nil {
		http.Error(w, "invalid bootstrap settings", http.StatusBadRequest)
		return
	}
	input.URL = strings.TrimSpace(input.URL)
	if input.URL == "" {
		http.Error(w, "url is required", http.StatusBadRequest)
		return
	}
	var settings map[string]any
	if err := c.Store.GetJSON("tailnet", &settings); err != nil {
		settings = map[string]any{}
	}
	settings["bootstrap_url"] = input.URL
	if err := c.Store.SetJSON("tailnet", settings); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = c.Store.Audit("settings.bootstrap", identityFromRequest(r))
	w.WriteHeader(http.StatusNoContent)
}

func (c *Control) saveDeployment(w http.ResponseWriter, r *http.Request) {
	var input map[string]string
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&input); err != nil {
		http.Error(w, "invalid deployment settings", http.StatusBadRequest)
		return
	}
	var settings map[string]any
	if err := c.Store.GetJSON("tailnet", &settings); err != nil {
		settings = map[string]any{}
	}
	for _, key := range []string{"management_url", "image", "cert_email", "gateway_hostname", "ingress_network"} {
		if value, ok := input[key]; ok {
			settings[key] = strings.TrimSpace(value)
		}
	}
	if err := c.Store.SetJSON("tailnet", settings); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = c.Store.Audit("settings.deployment", identityFromRequest(r))
	w.WriteHeader(http.StatusNoContent)
}
func (c *Control) providers(w http.ResponseWriter, _ *http.Request) {
	var b strings.Builder
	configured, _ := c.Store.Providers()
	b.WriteString(pageIntro("Infrastructure", "DNS providers", "Connect a supported libdns provider. Credentials are encrypted in SQLite and never rendered back to this page."))
	b.WriteString(`<section class="pf-surface pf-form-surface"><div class="pf-section-heading"><div><p class="pf-kicker">Add provider</p><h2>Provider connection</h2></div><span class="pf-pill pf-pill-neutral">Cloudflare · GoDaddy · Route 53</span></div><form id="provider-form" class="pf-form-grid" hx-post="/api/providers" hx-target="#provider-result"><label class="pf-field"><span class="pf-label">Connection ID</span><input class="pf-input" required name="id" placeholder="cloudflare-dev"><small class="pf-help">A stable name used by the ownership ledger.</small></label><label class="pf-field"><span class="pf-label">Provider</span><select class="pf-input" name="provider">`)
	for _, p := range dns.Catalog {
		fmt.Fprintf(&b, `<option value="%s">%s</option>`, template.HTMLEscapeString(p.ID), template.HTMLEscapeString(p.Name))
	}
	b.WriteString(`</select></label><label class="pf-field"><span class="pf-label">Managed zone</span><input class="pf-input" required name="zone" placeholder="example.com"></label><label class="pf-field"><span class="pf-label">Cloudflare account ID</span><input class="pf-input" name="account_id" placeholder="optional account ID"></label><label class="pf-field pf-field-wide"><span class="pf-label">Credentials JSON</span><textarea class="pf-input" required name="config" rows="4" placeholder="{&quot;api_token&quot;:&quot;...&quot;}"></textarea><small class="pf-help">Use a scoped token. Existing secrets are write-only.</small></label><div class="pf-form-actions"><button class="pf-button" type="submit">Save provider <span aria-hidden="true">→</span></button><span id="provider-result" class="pf-inline-result" role="status"></span></div></form></section>`)
	b.WriteString(`<section class="pf-surface"><div class="pf-section-heading"><div><p class="pf-kicker">Configured connections</p><h2>Provider health</h2></div><a class="pf-text-link" href="/api/providers">JSON</a></div>`)
	if len(configured) == 0 {
		b.WriteString(`<div class="pf-empty"><strong>No providers configured</strong><span>Add Cloudflare to discover and reconcile a zone.</span></div>`)
	} else {
		b.WriteString(`<div class="pf-table-wrap"><table class="pf-table"><thead><tr><th>Provider</th><th>Zone</th><th>State</th><th>Capabilities</th><th>Last test</th></tr></thead><tbody>`)
		for _, p := range configured {
			state := "Disabled"
			tone := "neutral"
			if p.Enabled {
				state, tone = "Enabled", "ok"
			}
			tested := "Not tested"
			if p.TestedAt > 0 {
				tested = unixLabel(p.TestedAt)
			}
			fmt.Fprintf(&b, `<tr><td data-label="Provider"><strong>%s</strong><small class="pf-muted">%s</small></td><td data-label="Zone"><code>%s</code></td><td data-label="State">%s</td><td data-label="Capabilities"><span class="pf-muted">%s</span></td><td data-label="Last test"><span class="pf-muted">%s</span></td></tr>`, safeText(p.ID), safeText(p.Provider), safeText(p.Zone), pill(state, tone), safeText(strings.Join(p.Capabilities, ", ")), safeText(tested))
		}
		b.WriteString(`</tbody></table></div>`)
	}
	b.WriteString(`</section>`)
	render(w, "DNS Providers", b.String())
}
func (c *Control) zones(w http.ResponseWriter, _ *http.Request) {
	zones, _ := c.Store.Zones()
	var b strings.Builder
	b.WriteString(pageIntro("Infrastructure", "Managed zones", "Assign an ownership ID before any record is changed. Discovery is read-only; reconciliation stays behind Operations."))
	b.WriteString(`<section class="pf-surface"><div class="pf-section-heading"><div><p class="pf-kicker">Ownership ledger</p><h2>Zones in scope</h2></div><a class="pf-text-link" href="/api/zones">Discover zones <span aria-hidden="true">→</span></a></div>`)
	if len(zones) == 0 {
		b.WriteString(`<div class="pf-empty"><strong>No managed zones</strong><span>Save a provider, discover its zones, then assign one to this control plane.</span></div>`)
	} else {
		b.WriteString(`<div class="pf-table-wrap"><table class="pf-table"><thead><tr><th>Provider</th><th>Zone</th><th>Ownership ID</th><th>State</th></tr></thead><tbody>`)
		for _, z := range zones {
			state, tone := "Disabled", "neutral"
			if z.Enabled {
				state, tone = "Ready", "ok"
			}
			fmt.Fprintf(&b, `<tr><td data-label="Provider"><strong>%s</strong></td><td data-label="Zone"><code>%s</code></td><td data-label="Ownership ID"><code>%s</code></td><td data-label="State">%s</td></tr>`, safeText(z.ProviderID), safeText(z.Zone), safeText(z.OwnerID), pill(state, tone))
		}
		b.WriteString(`</tbody></table></div>`)
	}
	b.WriteString(`</section><section class="pf-surface pf-form-surface"><div class="pf-section-heading"><div><p class="pf-kicker">Assign ownership</p><h2>Register a zone</h2></div></div><form class="pf-form-grid" method="post" action="/api/zones"><label class="pf-field"><span class="pf-label">Provider ID</span><input class="pf-input" name="provider_id" required placeholder="cloudflare-dev"></label><label class="pf-field"><span class="pf-label">Zone</span><input class="pf-input" name="zone" required placeholder="example.com"></label><label class="pf-field"><span class="pf-label">Ownership ID</span><input class="pf-input" name="owner_id" required placeholder="private-funnel-prod"></label><div class="pf-form-actions"><button class="pf-button" type="submit">Save ownership</button></div></form></section>`)
	render(w, "Zones", b.String())
}

func (c *Control) providerList(w http.ResponseWriter, _ *http.Request) {
	providers, err := c.Store.Providers()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(providers)
}

type providerInput struct {
	ID        string            `json:"id"`
	Provider  string            `json:"provider"`
	Zone      string            `json:"zone"`
	Config    map[string]string `json:"config"`
	AccountID string            `json:"account_id"`
	Enabled   *bool             `json:"enabled"`
}

func (c *Control) providerSave(w http.ResponseWriter, r *http.Request) {
	var in providerInput
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded") {
		in.ID, in.Provider, in.Zone = strings.TrimSpace(r.FormValue("id")), strings.TrimSpace(r.FormValue("provider")), strings.TrimSpace(r.FormValue("zone"))
		if err := json.Unmarshal([]byte(r.FormValue("config")), &in.Config); err != nil {
			http.Error(w, "config must be a JSON object", http.StatusBadRequest)
			return
		}
		if accountID := strings.TrimSpace(r.FormValue("account_id")); accountID != "" {
			if in.Config == nil {
				in.Config = map[string]string{}
			}
			in.Config["account_id"] = accountID
		}
	} else if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
		http.Error(w, "invalid provider", http.StatusBadRequest)
		return
	}
	if in.ID == "" || in.Provider == "" || in.Zone == "" || len(in.Config) == 0 {
		http.Error(w, "id, provider, zone, and config are required", http.StatusBadRequest)
		return
	}
	if _, ok := dns.Registry[in.Provider]; !ok {
		http.Error(w, "provider has no linked runtime adapter", http.StatusBadRequest)
		return
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	if err := c.Store.SaveProvider(in.ID, in.Provider, in.Zone, in.Config, enabled); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = c.Store.Audit("provider.save:"+in.ID, identityFromRequest(r))
	if r.Header.Get("HX-Request") == "true" {
		_, _ = w.Write([]byte("Provider saved."))
		return
	}
	w.WriteHeader(http.StatusCreated)
}

func (c *Control) providerTest(w http.ResponseWriter, r *http.Request) {
	p, config, err := c.Store.ProviderConfig(chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, "provider not found", http.StatusNotFound)
		return
	}
	factory := dns.Registry[p.Provider]
	if factory == nil {
		http.Error(w, "provider has no linked runtime adapter", http.StatusBadRequest)
		return
	}
	provider, err := factory(config)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	records, err := provider.List(r.Context(), p.Zone)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	capabilities := provider.Capabilities()
	_ = c.Store.MarkProviderTested(p.ID, capabilities)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"provider": p.ID, "zone": p.Zone, "records": len(records), "capabilities": capabilities})
}

func (c *Control) providerDelete(w http.ResponseWriter, r *http.Request) {
	if err := c.Store.DeleteProvider(chi.URLParam(r, "id")); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = c.Store.Audit("provider.delete:"+chi.URLParam(r, "id"), identityFromRequest(r))
	w.WriteHeader(http.StatusNoContent)
}

func (c *Control) providerEnable(w http.ResponseWriter, r *http.Request) {
	enabled := r.FormValue("enabled") != "false"
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		var input struct {
			Enabled *bool `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err == nil && input.Enabled != nil {
			enabled = *input.Enabled
		}
	}
	if err := c.Store.SetProviderEnabled(chi.URLParam(r, "id"), enabled); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = c.Store.Audit("provider.enable:"+chi.URLParam(r, "id"), identityFromRequest(r))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"id": chi.URLParam(r, "id"), "enabled": enabled})
}

func (c *Control) zoneList(w http.ResponseWriter, r *http.Request) {
	providers, err := c.Store.Providers()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	type zone struct {
		Provider string `json:"provider"`
		Zone     string `json:"zone"`
		Source   string `json:"source"`
	}
	var out []zone
	if managed, managedErr := c.Store.Zones(); managedErr == nil {
		for _, z := range managed {
			out = append(out, zone{Provider: z.ProviderID, Zone: z.Zone, Source: "managed"})
		}
	}
	for _, p := range providers {
		out = append(out, zone{Provider: p.ID, Zone: p.Zone, Source: "configured"})
		meta, config, configErr := c.Store.ProviderConfig(p.ID)
		if configErr != nil {
			continue
		}
		factory := dns.Registry[meta.Provider]
		if factory == nil {
			continue
		}
		provider, factoryErr := factory(config)
		if factoryErr != nil {
			continue
		}
		if lister, ok := provider.(interface {
			ListZones(context.Context) ([]libdns.Zone, error)
		}); ok {
			zones, listErr := lister.ListZones(r.Context())
			if listErr == nil {
				for _, z := range zones {
					out = append(out, zone{Provider: p.ID, Zone: z.Name, Source: "discovered"})
				}
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func (c *Control) zoneSave(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ProviderID string `json:"provider_id"`
		Zone       string `json:"zone"`
		OwnerID    string `json:"owner_id"`
		Enabled    *bool  `json:"enabled"`
	}
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded") {
		input.ProviderID, input.Zone, input.OwnerID = strings.TrimSpace(r.FormValue("provider_id")), strings.TrimSpace(r.FormValue("zone")), strings.TrimSpace(r.FormValue("owner_id"))
	} else if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input); err != nil {
		http.Error(w, "invalid zone", http.StatusBadRequest)
		return
	}
	if input.ProviderID == "" || input.Zone == "" || input.OwnerID == "" {
		http.Error(w, "provider_id, zone, and owner_id are required", http.StatusBadRequest)
		return
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	if err := c.Store.SaveZone(input.ProviderID, input.Zone, input.OwnerID, enabled); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = c.Store.Audit("zone.save:"+input.ProviderID+":"+input.Zone, identityFromRequest(r))
	if r.Header.Get("HX-Request") == "true" {
		fmt.Fprint(w, "Zone ownership saved.")
		return
	}
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded") {
		http.Redirect(w, r, "/zones", http.StatusSeeOther)
		return
	}
	w.WriteHeader(http.StatusCreated)
}

type syncRecord struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Data string `json:"data"`
	TTL  int    `json:"ttl"`
}

type syncInput struct {
	ProviderID    string       `json:"provider_id"`
	OwnerID       string       `json:"owner_id"`
	Records       []syncRecord `json:"records"`
	DryRun        bool         `json:"dry_run"`
	AllowUnowned  bool         `json:"allow_unowned"`
	ApprovalToken string       `json:"approval_token"`
}

func (c *Control) sync(w http.ResponseWriter, r *http.Request) {
	var in syncInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
		http.Error(w, "invalid sync request", http.StatusBadRequest)
		return
	}
	if in.ProviderID == "" || in.OwnerID == "" {
		http.Error(w, "provider_id and owner_id are required", http.StatusBadRequest)
		return
	}
	desired := make([]libdns.Record, 0, len(in.Records))
	for _, item := range in.Records {
		if item.Name == "" || item.Type == "" {
			http.Error(w, "record name and type are required", http.StatusBadRequest)
			return
		}
		ttl := time.Duration(item.TTL) * time.Second
		desired = append(desired, libdns.RR{Name: item.Name, Type: strings.ToUpper(item.Type), Data: item.Data, TTL: ttl})
	}
	result, err := c.reconcile(r.Context(), in.ProviderID, in.OwnerID, desired, in.DryRun, in.AllowUnowned, in.ApprovalToken)
	if err != nil {
		http.Error(w, err.Error(), resultStatus(err))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	result["dry_run"] = in.DryRun
	result["owner_id"] = in.OwnerID
	_ = json.NewEncoder(w).Encode(result)
}

func resultStatus(err error) int {
	if strings.Contains(err.Error(), "unowned provider record") || strings.Contains(err.Error(), "record ownership conflict") || strings.Contains(err.Error(), "overwrite approval") {
		return http.StatusConflict
	}
	if strings.Contains(err.Error(), "not found") {
		return http.StatusNotFound
	}
	if strings.Contains(err.Error(), "disabled") {
		return http.StatusConflict
	}
	if strings.Contains(err.Error(), "adapter") {
		return http.StatusBadRequest
	}
	return http.StatusBadGateway
}

func (c *Control) reconcile(ctx context.Context, providerID, ownerID string, desired []libdns.Record, dryRun, allowUnowned bool, approvalToken ...string) (map[string]any, error) {
	c.syncMu.Lock()
	defer c.syncMu.Unlock()
	p, config, err := c.Store.ProviderConfig(providerID)
	if err != nil {
		return nil, fmt.Errorf("provider not found")
	}
	if !p.Enabled {
		return nil, fmt.Errorf("provider is disabled")
	}
	factory := dns.Registry[p.Provider]
	if factory == nil {
		return nil, fmt.Errorf("provider has no linked runtime adapter")
	}
	provider, err := factory(config)
	if err != nil {
		return nil, err
	}
	capabilities := make(map[string]bool)
	for _, capability := range provider.Capabilities() {
		capabilities[strings.ToUpper(capability)] = true
	}
	for _, record := range desired {
		if !capabilities[strings.ToUpper(record.RR().Type)] {
			return nil, fmt.Errorf("provider does not support %s records", record.RR().Type)
		}
	}
	if strings.TrimSpace(ownerID) == "" {
		return nil, fmt.Errorf("owner ID is required")
	}
	zone := strings.ToLower(strings.TrimSuffix(p.Zone, "."))
	desired = dns.NormalizeRecords(desired, zone)
	for _, record := range desired {
		name := strings.ToLower(strings.TrimSuffix(record.RR().Name, "."))
		if name != zone && !strings.HasSuffix(name, "."+zone) {
			return nil, fmt.Errorf("record %s is outside zone %s", name, zone)
		}
	}
	allLedger, err := c.Store.ZoneLedger(p.Zone)
	if err != nil {
		return nil, err
	}
	existing, err := provider.List(ctx, p.Zone)
	if err != nil {
		return nil, fmt.Errorf("list provider records: %w", err)
	}
	existing = dns.NormalizeRecords(existing, zone)
	add, remove, err := dns.OwnershipPlan(ownerID, allLedger, existing, desired, false)
	requiresApproval := err != nil
	if requiresApproval && dryRun {
		add, remove, err = dns.OwnershipPlan(ownerID, allLedger, existing, desired, true)
		if err != nil {
			return nil, err
		}
		token, tokenErr := c.approval(providerID, ownerID, desired, existing, allLedger, "")
		if tokenErr != nil {
			return nil, tokenErr
		}
		return map[string]any{"add": len(add), "remove": len(remove), "requires_approval": true, "approval_token": token, "existing_records": recordViews(existing), "desired_records": recordViews(desired)}, nil
	}
	if allowUnowned && !dryRun {
		token := ""
		if len(approvalToken) > 0 {
			token = approvalToken[0]
		}
		if token == "" {
			return nil, fmt.Errorf("overwrite approval is required; preview the specific changes first")
		}
		if _, approvalErr := c.approval(providerID, ownerID, desired, existing, allLedger, token); approvalErr != nil {
			return nil, approvalErr
		}
		add, remove, err = dns.OwnershipPlan(ownerID, allLedger, existing, desired, true)
	}
	if err != nil {
		return nil, err
	}
	if !dryRun {
		if err := provider.Apply(ctx, p.Zone, add, remove); err != nil {
			return nil, err
		}
		if allowUnowned {
			transferred := append(append(append([]libdns.Record{}, desired...), add...), remove...)
			if err := c.Store.TransferZoneLedgerOwnership(p.Zone, ownerID, transferred); err != nil {
				return nil, err
			}
		}
		if err := c.Store.ReplaceLedger(p.ID, p.Zone, ownerID, desired); err != nil {
			return nil, err
		}
		_ = c.Store.Audit("dns.reconcile:"+ownerID, "control")
		if allowUnowned {
			_ = c.Store.Audit("dns.explicit-overwrite:"+ownerID, "administrator")
		}
	}
	return map[string]any{"add": len(add), "remove": len(remove), "requires_approval": false}, nil
}

type exposureInput struct {
	Kind          string `json:"kind"`
	ProviderID    string `json:"provider_id"`
	OwnerID       string `json:"owner_id"`
	DryRun        bool   `json:"dry_run"`
	AllowUnowned  bool   `json:"allow_unowned"`
	ApprovalToken string `json:"approval_token"`
	dns.RouterExposure
	Gateway dns.GatewayEndpoint `json:"gateway"`
}

func (c *Control) exposureSync(w http.ResponseWriter, r *http.Request) {
	var in exposureInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
		http.Error(w, "invalid exposure", 400)
		return
	}
	if in.ProviderID == "" || in.OwnerID == "" {
		http.Error(w, "provider_id and owner_id are required", 400)
		return
	}
	var records []libdns.Record
	var err error
	if in.Kind == "router" {
		records, err = dns.RouterRecords(in.RouterExposure)
		if err == nil {
			p := principal(r)
			routerID := strings.TrimPrefix(in.OwnerID, "router:")
			if !c.exposureAllowed(in.RouterExposure, []string{routerID, in.OwnerID, p.NodeID}, p.RoleSelectors()) {
				http.Error(w, "router exposure is not allowed by the control policy", http.StatusForbidden)
				return
			}
		}
	} else if in.Kind == "gateway" {
		var record libdns.Record
		record, _, err = dns.GatewayRecord(in.Gateway)
		if err == nil {
			records = []libdns.Record{record}
		}
	} else {
		err = fmt.Errorf("kind must be gateway or router")
	}
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	result, err := c.reconcile(r.Context(), in.ProviderID, in.OwnerID, records, in.DryRun, in.AllowUnowned, in.ApprovalToken)
	if err != nil {
		http.Error(w, err.Error(), resultStatus(err))
		return
	}
	result["dry_run"] = in.DryRun
	result["owner_id"] = in.OwnerID
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}

func (c *Control) operations(w http.ResponseWriter, _ *http.Request) {
	render(w, "Operations", pageIntro("Operations", "DNS operations", "Preview the exact desired state, separate owned records from unowned records, and explicitly approve any overwrite before applying.")+`<div class="pf-alert pf-alert-warn"><strong>Ownership guardrail.</strong> The control plane never changes a record outside this installation's ownership ledger unless an administrator approves the specific preview.</div><section class="pf-surface pf-form-surface"><div class="pf-section-heading"><div><p class="pf-kicker">Dry-run first</p><h2>Reconcile records</h2></div><a class="pf-text-link" href="/api/reports">View reports <span aria-hidden="true">→</span></a></div><label class="pf-field"><span class="pf-label">Sync request JSON</span><textarea class="pf-input font-mono" id="sync-input" rows="10">{"provider_id":"","owner_id":"","records":[],"dry_run":true}</textarea></label><div class="pf-form-actions"><button class="pf-button" id="preview" type="button">Preview changes <span aria-hidden="true">→</span></button><label class="pf-check-field"><input id="approve" type="checkbox"><span><strong>Approve unowned overwrite</strong><small class="pf-help">Only the records shown in the latest preview can be transferred.</small></span></label><button class="pf-secondary-button" id="apply" type="button" disabled>Apply approved preview</button></div><pre class="pf-command" id="sync-result" aria-live="polite"></pre></section>
<script>
const input=document.getElementById('sync-input'), result=document.getElementById('sync-result'), approve=document.getElementById('approve'), apply=document.getElementById('apply'); let token='', requiresApproval=false;
async function send(body){const r=await fetch('/api/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const t=await r.text();result.textContent=t;return {r,t}}
document.getElementById('preview').onclick=async()=>{try{const b=JSON.parse(input.value);b.dry_run=true;b.allow_unowned=false;const x=await send(b);if(x.r.ok){const j=JSON.parse(x.t);token=j.approval_token||'';requiresApproval=Boolean(j.requires_approval);apply.disabled=requiresApproval&&!token;}}catch(e){result.textContent=e}}
apply.onclick=async()=>{if(requiresApproval&&(!approve.checked||!token))return;try{const b=JSON.parse(input.value);b.dry_run=false;b.allow_unowned=requiresApproval;b.approval_token=token;await send(b)}catch(e){result.textContent=e}}
</script>`)
}

func (c *Control) loadExposurePolicy() policy.Document {
	document := policy.Document{Rules: []policy.Rule{}}
	if err := c.Store.GetJSON("exposure_policy", &document); err != nil {
		return policy.Document{}
	}
	return document
}

func (c *Control) exposureAllowed(exposure dns.RouterExposure, routerIDs, roles []string) bool {
	allowed, _ := c.loadExposurePolicy().Allows(exposure.PublicHostname, exposure.GatewayHostname, routerIDs, roles)
	return allowed
}

func (c *Control) policies(w http.ResponseWriter, _ *http.Request) {
	document := c.loadExposurePolicy()
	b, _ := json.MarshalIndent(document, "", "  ")
	initial := template.HTMLEscapeString(string(b))
	render(w, "Router exposure policy", pageIntro("Access", "Exposure policy", "Default deny keeps router labels from becoming public DNS. Add a narrow rule for the hostnames and Tailscale roles that are allowed to publish.")+`<div class="pf-alert pf-alert-info"><strong>Default deny is active.</strong> A report is accepted only when hostname, gateway, and router identity match an enabled rule.</div><section class="pf-surface pf-form-surface"><div class="pf-section-heading"><div><p class="pf-kicker">Guided rule editor</p><h2>Add an authorization rule</h2></div><span class="pf-pill pf-pill-neutral">RE2 regex</span></div><form class="pf-form-grid" hx-post="/api/policies/rule" hx-target="#policy-result"><label class="pf-field"><span class="pf-label">Rule name</span><input class="pf-input" name="name" placeholder="Development services"></label><label class="pf-field"><span class="pf-label">Hostname regex</span><input class="pf-input font-mono" name="hostname_regex" required placeholder="[^.]+[.]dev[.]example[.]com"><small class="pf-help">The expression is anchored to the complete hostname.</small></label><label class="pf-field"><span class="pf-label">Router roles</span><input class="pf-input" name="roles" placeholder="tag:router-dev,group:platform"></label><label class="pf-field"><span class="pf-label">Router node IDs</span><input class="pf-input" name="router_ids" placeholder="router-node-id"></label><label class="pf-field"><span class="pf-label">Gateway hostnames</span><input class="pf-input" name="gateway_hostnames" placeholder="gateway.example.com"></label><label class="pf-field pf-check-field"><input type="checkbox" name="enabled" checked><span><strong>Enabled</strong><small class="pf-help">Enable publication immediately after saving.</small></span></label><div class="pf-form-actions"><button class="pf-button" type="submit">Save rule <span aria-hidden="true">→</span></button><span id="policy-result" class="pf-inline-result" role="status"></span></div></form></section><section class="pf-surface"><div class="pf-section-heading"><div><p class="pf-kicker">Current rules</p><h2>Policy coverage</h2></div><span class="pf-pill pf-pill-neutral">`+fmt.Sprintf("%d rules", len(document.Rules))+`</span></div>`+policyRuleTable(document)+`</section><section class="pf-surface pf-form-surface"><details><summary class="pf-summary">Advanced JSON import / export</summary><form method="post" action="/api/policies" hx-post="/api/policies" hx-target="#policy-json-result"><label class="pf-field"><span class="pf-label">Policy document</span><textarea class="pf-input font-mono" name="policy" rows="16" required>`+initial+`</textarea></label><button class="pf-secondary-button" type="submit">Validate JSON</button></form><pre id="policy-json-result"></pre></details></section>`)
}

func policyRuleTable(document policy.Document) string {
	if len(document.Rules) == 0 {
		return `<div class="pf-empty"><strong>No rules configured</strong><span>Automatic router reports stay denied until you add a matching rule.</span></div>`
	}
	var b strings.Builder
	b.WriteString(`<div class="pf-table-wrap"><table class="pf-table"><thead><tr><th>Name</th><th>Hostname</th><th>Router selectors</th><th>Gateways</th><th>State</th></tr></thead><tbody>`)
	for _, rule := range document.Rules {
		state, tone := "Disabled", "neutral"
		if rule.Enabled {
			state, tone = "Enabled", "ok"
		}
		selectors := append(append([]string{}, rule.Roles...), rule.RouterIDs...)
		gateways := strings.Join(rule.GatewayHostnames, ", ")
		fmt.Fprintf(&b, `<tr><td data-label="Name"><strong>%s</strong></td><td data-label="Hostname"><code>%s</code></td><td data-label="Router selectors"><span class="pf-muted">%s</span></td><td data-label="Gateways"><span class="pf-muted">%s</span></td><td data-label="State">%s</td></tr>`, safeText(rule.Name), safeText(rule.HostnameRegex), safeText(strings.Join(selectors, ", ")), safeText(gateways), pill(state, tone))
	}
	b.WriteString(`</tbody></table></div>`)
	return b.String()
}

func (c *Control) policyRuleSave(w http.ResponseWriter, r *http.Request) {
	document := c.loadExposurePolicy()
	rule := policy.Rule{Name: strings.TrimSpace(r.FormValue("name")), HostnameRegex: strings.TrimSpace(r.FormValue("hostname_regex")), Roles: splitValues(r.FormValue("roles")), RouterIDs: splitValues(r.FormValue("router_ids")), GatewayHostnames: splitValues(r.FormValue("gateway_hostnames")), Enabled: r.FormValue("enabled") == "on" || r.FormValue("enabled") == "true"}
	document.Rules = append(document.Rules, rule)
	if err := document.Validate(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := c.Store.SetJSON("exposure_policy", document); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = c.Store.Audit("exposure-policy.rule.save", identityFromRequest(r))
	if r.Header.Get("HX-Request") == "true" {
		fmt.Fprint(w, `<span class="pf-result-success">Rule saved. Reload the policy page to review coverage.</span>`)
		return
	}
	http.Redirect(w, r, "/policies", http.StatusSeeOther)
}

func (c *Control) policyTest(w http.ResponseWriter, r *http.Request) {
	hostname, gateway := strings.TrimSpace(r.FormValue("hostname")), strings.TrimSpace(r.FormValue("gateway_hostname"))
	allowed, matched := c.loadExposurePolicy().Allows(hostname, gateway, splitValues(r.FormValue("router_ids")), splitValues(r.FormValue("roles")))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"allowed": allowed, "matched_rule": matched, "hostname": hostname})
}

func (c *Control) policyGet(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(c.loadExposurePolicy())
}

func (c *Control) policySave(w http.ResponseWriter, r *http.Request) {
	var document policy.Document
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&document); err != nil {
			http.Error(w, "invalid policy JSON", http.StatusBadRequest)
			return
		}
	} else {
		rules := strings.TrimSpace(r.FormValue("policy"))
		if rules == "" {
			http.Error(w, "policy JSON is required", http.StatusBadRequest)
			return
		}
		if err := json.Unmarshal([]byte(rules), &document); err != nil {
			http.Error(w, "invalid policy JSON: "+err.Error(), http.StatusBadRequest)
			return
		}
	}
	if err := document.Validate(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := c.Store.SetJSON("exposure_policy", document); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = c.Store.Audit("exposure-policy.save", identityFromRequest(r))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(document)
}

func (c *Control) exposures(w http.ResponseWriter, _ *http.Request) {
	reports, err := c.Store.Reports()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var b strings.Builder
	b.WriteString(pageIntro("Overview", "Exposures", "Signed router reports become DNS desired state only when the hostname, gateway, and router identity pass policy."))
	b.WriteString(`<section class="pf-surface"><div class="pf-section-heading"><div><p class="pf-kicker">Approved routes</p><h2>Public hostnames</h2></div><span class="pf-pill pf-pill-ok"><i class="pf-status-dot pf-status-ok"></i> Ownership scoped</span></div>`)
	rows := 0
	for nodeID, raw := range reports {
		var envelope report.Envelope
		if json.Unmarshal([]byte(raw), &envelope) != nil {
			continue
		}
		var payload struct {
			Exposures []dns.RouterExposure `json:"exposures"`
			ExpiresAt int64                `json:"expires_at"`
		}
		if json.Unmarshal(envelope.Payload, &payload) != nil {
			continue
		}
		for _, exposure := range payload.Exposures {
			rows++
			fmt.Fprintf(&b, `<div class="pf-exposure-row"><div><strong class="font-mono">%s</strong><small class="pf-muted">gateway · %s</small></div><div><span class="pf-muted">Backend</span><code>%s:%d</code></div><div><span class="pf-muted">Router</span><code>%s</code></div><div>%s<small class="pf-muted">expires %s</small></div></div>`, safeText(exposure.PublicHostname), safeText(exposure.GatewayHostname), safeText(exposure.BackendHostname), exposure.Port, safeText(nodeID), pill("Allowed", "ok"), safeText(unixLabel(payload.ExpiresAt)))
		}
	}
	if rows == 0 {
		b.WriteString(`<div class="pf-empty"><strong>No active exposures</strong><span>Start a labeled router service covered by an enabled policy rule to see it here.</span><a class="pf-text-link" href="/policies">Review exposure policy <span aria-hidden="true">→</span></a></div>`)
	}
	b.WriteString(`</section><section class="pf-surface"><details><summary class="pf-summary">Advanced report payloads</summary><pre class="pf-command">` + template.HTMLEscapeString(func() string { raw, _ := json.MarshalIndent(reports, "", "  "); return string(raw) }()) + `</pre></details></section>`)
	render(w, "Exposures", b.String())
}

func (c *Control) reports(w http.ResponseWriter, _ *http.Request) {
	reports, err := c.Store.Reports()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(reports)
}

func (c *Control) audit(w http.ResponseWriter, _ *http.Request) {
	events, err := c.Store.AuditEvents(100)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(events)
}

func (c *Control) ExpireReports(ctx context.Context, maxAge time.Duration) (int, error) {
	ids, err := c.Store.StaleReportIDs(time.Now().Add(-maxAge).Unix())
	if err != nil {
		return 0, err
	}
	providers, err := c.Store.Providers()
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, id := range ids {
		for _, provider := range providers {
			if !provider.Enabled {
				continue
			}
			if _, err := c.reconcile(ctx, provider.ID, "router:"+id, nil, false, false); err != nil {
				return removed, err
			}
		}
		if err := c.Store.DeleteReport(id); err != nil {
			return removed, err
		}
		removed++
	}
	return removed, nil
}

func (c *Control) expireReports(w http.ResponseWriter, r *http.Request) {
	removed, err := c.ExpireReports(r.Context(), 5*time.Minute)
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	_ = c.Store.Audit("reports.expire", identityFromRequest(r))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"removed": removed})
}

func (c *Control) saveReport(w http.ResponseWriter, r *http.Request) {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	var envelope report.Envelope
	if err := dec.Decode(&envelope); err != nil {
		http.Error(w, "invalid report", http.StatusBadRequest)
		return
	}
	if _, _, err := report.Verify(envelope, time.Now(), 5*time.Minute); err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	p := principal(r)
	node, nodeErr := c.Store.Node(strings.TrimSpace(envelope.NodeID))
	if p.NodeID == "" || nodeErr != nil || node.TailnetID == "" || node.TailnetID != p.NodeID {
		http.Error(w, fmt.Sprintf("report node does not match enrolled tailnet identity (report=%s whois=%s stored=%s err=%v)", envelope.NodeID, p.NodeID, node.TailnetID, nodeErr), 403)
		return
	}
	revoked, err := c.Store.NodeRevoked(strings.TrimSpace(envelope.NodeID))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if revoked {
		http.Error(w, "unknown or revoked node", http.StatusForbidden)
		return
	}
	var freshness struct {
		ExpiresAt int64 `json:"expires_at"`
	}
	if err := json.Unmarshal(envelope.Payload, &freshness); err != nil || freshness.ExpiresAt <= time.Now().Unix() || freshness.ExpiresAt > envelope.Timestamp+int64(5*time.Minute/time.Second) {
		http.Error(w, "invalid report expiry", 400)
		return
	}
	var reportPayload struct {
		ProviderID string               `json:"provider_id"`
		Exposures  []dns.RouterExposure `json:"exposures"`
	}
	if err := json.Unmarshal(envelope.Payload, &reportPayload); err != nil {
		http.Error(w, "invalid report payload", http.StatusBadRequest)
		return
	}
	providerID := reportPayload.ProviderID
	if providerID == "" {
		if providers, listErr := c.Store.Providers(); listErr == nil {
			for _, provider := range providers {
				if provider.Enabled {
					providerID = provider.ID
					break
				}
			}
		}
	}
	var desired []libdns.Record
	routerIDs := []string{envelope.NodeID, p.NodeID, node.TailnetID, node.Hostname}
	roles := p.RoleSelectors()
	for _, exposure := range reportPayload.Exposures {
		match := false
		for _, addr := range p.Addresses {
			if prefix, err := netip.ParsePrefix(addr); err == nil && prefix.Addr().String() == exposure.BackendIP {
				match = true
			}
			if addr == exposure.BackendIP {
				match = true
			}
		}
		if !match {
			http.Error(w, "backend must use reporting router tailnet address", 403)
			return
		}
		records, recordErr := dns.RouterRecords(exposure)
		if recordErr != nil {
			http.Error(w, recordErr.Error(), http.StatusBadRequest)
			return
		}
		if !c.exposureAllowed(exposure, routerIDs, roles) {
			http.Error(w, "router exposure is not allowed by the control policy", http.StatusForbidden)
			return
		}
		desired = append(desired, records...)
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := c.Store.AcceptReport(strings.TrimSpace(envelope.NodeID), envelope.Nonce, payload, envelope.PublicKey); err != nil {
		if strings.Contains(err.Error(), "nonce already used") {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if providerID != "" {
		if _, syncErr := c.reconcile(r.Context(), providerID, "router:"+envelope.NodeID, desired, false, false); syncErr != nil {
			http.Error(w, "report accepted but DNS reconciliation failed: "+syncErr.Error(), http.StatusBadGateway)
			return
		}
	}
	w.WriteHeader(http.StatusAccepted)
}
func (c *Control) nodes(w http.ResponseWriter, r *http.Request) {
	mode := "gateway"
	if r.URL.Path == "/routers" {
		mode = "router"
	}
	nodes, _ := c.Store.Nodes(mode)
	title, kicker, description, href := "Gateways", "Infrastructure", "The public edge terminates TLS and resolves request-specific SRV records to approved tailnet backends.", "/enroll/gateway"
	if mode == "router" {
		title, description, href = "Routers", "Routers discover only labeled HTTP containers on the dedicated ingress network and report signed desired state to the control plane.", "/enroll/router"
	}
	var b strings.Builder
	b.WriteString(pageIntro(kicker, title, description))
	b.WriteString(`<div class="pf-action-row"><a class="pf-button" href="` + href + `">Create ` + strings.ToLower(strings.TrimSuffix(title, "s")) + ` enrollment <span aria-hidden="true">→</span></a><a class="pf-secondary-button" href="/api/nodes/` + mode + `">View JSON</a></div><section class="pf-surface"><div class="pf-section-heading"><div><p class="pf-kicker">Node inventory</p><h2>Connected ` + strings.ToLower(title) + `</h2></div><span class="pf-pill pf-pill-neutral">` + fmt.Sprintf("%d total", len(nodes)) + `</span></div>`)
	if len(nodes) == 0 {
		b.WriteString(`<div class="pf-empty"><strong>No ` + strings.ToLower(title) + ` enrolled</strong><span>Use the generated command to join a node, then return here to confirm its identity and report state.</span></div>`)
	} else {
		b.WriteString(`<div class="pf-table-wrap"><table class="pf-table"><thead><tr><th>Hostname</th><th>Tailnet identity</th><th>Health</th><th>Last report</th><th>Action</th></tr></thead><tbody>`)
		for _, node := range nodes {
			revoked := node["revoked"] == true
			state, tone := "Healthy", "ok"
			if revoked {
				state, tone = "Revoked", "error"
			}
			last := int64(0)
			if value, ok := node["last_report"].(int64); ok {
				last = value
			}
			fmt.Fprintf(&b, `<tr><td data-label="Hostname"><strong>%s</strong><small class="pf-muted">%s</small></td><td data-label="Tailnet identity"><code>%s</code></td><td data-label="Health">%s</td><td data-label="Last report"><span class="pf-muted">%s</span></td><td data-label="Action"><a class="pf-text-link" href="/api/nodes/%s">Inspect</a></td></tr>`, safeText(stringValue(node, "hostname", "—")), safeText(stringValue(node, "mode", mode)), safeText(stringValue(node, "id", "—")), pill(state, tone), safeText(unixLabel(last)), safeText(stringValue(node, "id", "")))
		}
		b.WriteString(`</tbody></table></div>`)
	}
	b.WriteString(`</section>`)
	if mode == "router" {
		b.WriteString(`<section class="pf-surface"><div class="pf-section-heading"><div><p class="pf-kicker">Ingress guidance</p><h2>Keep the route private</h2></div></div><p class="pf-muted">Attach the router and each HTTP service to the configured ingress network. Use <code>caddy</code> and <code>caddy.reverse_proxy={{upstreams PORT}}</code> labels. A hostname must match an enabled policy rule before DNS changes.</p></section>`)
	}
	render(w, title, b.String())
}
func (c *Control) enroll(w http.ResponseWriter, r *http.Request) {
	mode := chi.URLParam(r, "mode")
	if mode != "gateway" && mode != "router" {
		http.Error(w, "invalid mode", 400)
		return
	}
	description := "The generated command joins Tailscale, persists identity under the selected state directory, and starts the gateway."
	if mode == "router" {
		description = "The generated commands join Tailscale, mount the Docker socket, use the configured ingress network, and start label discovery. A router report is accepted only when the exposure policy allows every hostname."
	}
	render(w, "Enrollment", pageIntro("Infrastructure", strings.Title(mode)+" enrollment", description)+fmt.Sprintf(`<div class="pf-alert pf-alert-info"><strong>Reusable enrollment code.</strong> Each redemption mints a short-lived auth key. OAuth credentials stay in the control service.</div><section class="pf-surface pf-form-surface"><div class="pf-section-heading"><div><p class="pf-kicker">Step 1 · Identity</p><h2>Choose a node hostname</h2></div><span class="pf-pill pf-pill-neutral">1 of 3</span></div><form id="enrollment-form" class="pf-form-grid"><label class="pf-field"><span class="pf-label">Node hostname</span><input class="pf-input" name="hostname" value="%s-node" required><small class="pf-help">Use a stable name that is easy to identify in Tailscale.</small></label><div class="pf-form-actions"><button class="pf-button" type="submit">Generate commands <span aria-hidden="true">→</span></button></div></form></section><section class="pf-surface"><div class="pf-section-heading"><div><p class="pf-kicker">Step 2 · Deploy</p><h2>Generated instructions</h2></div><span class="pf-pill pf-pill-neutral">Waiting for input</span></div><pre class="pf-command" id="enrollment-result" aria-live="polite">Complete the hostname step to generate a native or Docker command.</pre></section><p><a class="pf-text-link" href="/%ss">Back to %ss <span aria-hidden="true">→</span></a></p><script>document.getElementById('enrollment-form').onsubmit=async function(e){e.preventDefault();const result=document.getElementById('enrollment-result');const r=await fetch('/api/enrollments/%s',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hostname:this.hostname.value})});const text=await r.text();if(!r.ok){result.textContent=text;return}let data;try{data=JSON.parse(text)}catch(_){result.textContent=text;return}const lines=['Enrollment created. Keep the code private until the target node has joined.','','Steps:',...(data.instructions||[]).map((step,i)=>(i+1)+'. '+step),'','Native commands:',data.command||'','', 'Docker join:',data.docker_join||'','', 'Docker serve:',data.docker_serve||'','', 'Router label example:',data.label_example||'','', 'Exposure policy:',data.policy_url||'/policies'];result.textContent=lines.join('\n')}</script>`, mode, mode, strings.Title(mode), mode))
}
func (c *Control) authKey(w http.ResponseWriter, r *http.Request) {
	mode := chi.URLParam(r, "mode")
	if mode != "gateway" && mode != "router" {
		http.Error(w, "invalid mode", 400)
		return
	}
	var settings struct {
		Name string `json:"name"`
		Tags string `json:"tags"`
	}
	if err := c.Store.GetJSON("tailnet", &settings); err != nil || settings.Name == "" {
		http.Error(w, "configure the tailnet first", 428)
		return
	}
	id, err := c.Store.GetSecret("tailscale_oauth_client_id")
	if err != nil {
		http.Error(w, "configure OAuth credentials first", 428)
		return
	}
	secret, err := c.Store.GetSecret("tailscale_oauth_client_secret")
	if err != nil {
		http.Error(w, "configure OAuth credentials first", 428)
		return
	}
	var tags []string
	for _, tag := range strings.Split(settings.Tags, ",") {
		if tag = strings.TrimSpace(tag); tag != "" {
			tags = append(tags, tag)
		}
	}
	if len(tags) == 0 {
		http.Error(w, "configure at least one permitted auth-key tag", http.StatusPreconditionRequired)
		return
	}
	enrollmentID := r.URL.Query().Get("enrollment_id")
	code := r.URL.Query().Get("code")
	if enrollmentID == "" {
		enrollmentID = r.FormValue("enrollment_id")
	}
	if code == "" {
		code = r.FormValue("code")
	}
	if enrollmentID == "" || code == "" {
		http.Error(w, "enrollment ID and code required", 403)
		return
	}
	nodeID, hostname := mode+"-node", mode+"-node"
	if enrollmentID != "" {
		e, redeemErr := c.Store.RedeemEnrollment(enrollmentID, code)
		if redeemErr != nil || e.Mode != mode {
			http.Error(w, "invalid enrollment", http.StatusForbidden)
			return
		}
		nodeID, hostname = e.ID, e.Hostname
	}
	key, err := (tailscale.Client{ClientID: id, ClientSecret: secret, Tailnet: settings.Name}).CreateAuthKey(r.Context(), mode, hostname, tags)
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	var nodeErr error
	if enrollmentID != "" {
		nodeErr = c.Store.UpsertNodeEnrollment(nodeID, enrollmentID, mode, hostname)
	} else {
		nodeErr = c.Store.UpsertNode(nodeID, mode, hostname)
	}
	if nodeErr != nil {
		http.Error(w, nodeErr.Error(), http.StatusInternalServerError)
		return
	}
	_ = c.Store.Audit("auth-key.issue:"+nodeID, identityFromRequest(r))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = fmt.Fprintln(w, key)
}

func (c *Control) enrollmentCreate(w http.ResponseWriter, r *http.Request) {
	mode := chi.URLParam(r, "mode")
	if mode != "gateway" && mode != "router" {
		http.Error(w, "invalid mode", 400)
		return
	}
	var input struct {
		Hostname string `json:"hostname"`
	}
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		_ = json.NewDecoder(r.Body).Decode(&input)
	} else {
		input.Hostname = r.FormValue("hostname")
	}
	if strings.TrimSpace(input.Hostname) == "" {
		input.Hostname = mode + "-node"
	}
	e, code, err := c.Store.CreateEnrollment(mode, strings.TrimSpace(input.Hostname))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	_ = c.Store.Audit("enrollment.create:"+e.ID, identityFromRequest(r))
	var settings struct {
		Tags          string `json:"tags"`
		Image         string `json:"image"`
		ManagementURL string `json:"management_url"`
		BootstrapURL  string `json:"bootstrap_url"`
		CertEmail     string `json:"cert_email"`
		GatewayHost   string `json:"gateway_hostname"`
		Ingress       string `json:"ingress_network"`
	}
	_ = c.Store.GetJSON("tailnet", &settings)
	if settings.Image == "" {
		settings.Image = "ghcr.io/tailscale-x/tailscale-private-funnel:dev"
	}
	managementURL := settings.ManagementURL
	if managementURL == "" {
		_ = c.Store.RevokeEnrollment(e.ID)
		http.Error(w, "configure a tailnet management URL in Tailscale settings first", http.StatusPreconditionRequired)
		return
	}
	bootstrapURL := settings.BootstrapURL
	if bootstrapURL == "" {
		_ = c.Store.RevokeEnrollment(e.ID)
		http.Error(w, "configure an enrollment bootstrap URL in Tailscale settings first", http.StatusPreconditionRequired)
		return
	}
	joinArgs := fmt.Sprintf("%s join --non-interactive --management-url %s --bootstrap-url %s --hostname %s --enrollment-id %s --enrollment-code %s --advertise-tags %s --state-dir ${XDG_STATE_HOME:-$HOME/.local/state}/tailscale-private-funnel/%s --data-dir ${XDG_DATA_HOME:-$HOME/.local/share}/tailscale-private-funnel/%s", mode, shellQuote(managementURL), shellQuote(bootstrapURL), shellQuote(e.Hostname), shellQuote(e.ID), shellQuote(code), shellQuote(settings.Tags), mode, mode)
	serveArgs := fmt.Sprintf("%s serve --management-url %s --hostname %s --state-dir ${XDG_STATE_HOME:-$HOME/.local/state}/tailscale-private-funnel/%s --data-dir ${XDG_DATA_HOME:-$HOME/.local/share}/tailscale-private-funnel/%s", mode, shellQuote(managementURL), shellQuote(e.Hostname), mode, mode)
	if settings.CertEmail != "" {
		serveArgs += " --cert-email " + shellQuote(settings.CertEmail)
	}
	if settings.GatewayHost != "" {
		serveArgs += " --gateway-hostname " + shellQuote(settings.GatewayHost)
	}
	if settings.Ingress != "" {
		serveArgs += " --ingress-network " + shellQuote(settings.Ingress)
	}
	command := "tailscale-private-funnel " + joinArgs + " && tailscale-private-funnel " + serveArgs
	volumeArgs := fmt.Sprintf("-v $PWD/%s-state:/state -v $PWD/%s-data:/data", mode, mode)
	// Bind-mounted state/data directories are created by the invoking user. Run
	// the container as that user so the non-root image can persist its identity,
	// certificates, and report key without requiring host-wide chown operations.
	dockerUser := `--user "$(id -u):$(id -g)"`
	dockerDirs := fmt.Sprintf("mkdir -p %s-state %s-data &&", mode, mode)
	dockerJoin := fmt.Sprintf("%s docker run --rm %s %s %s %s join --non-interactive --management-url %s --bootstrap-url %s --hostname %s --enrollment-id %s --enrollment-code %s --advertise-tags %s --state-dir /state --data-dir /data", dockerDirs, dockerUser, volumeArgs, shellQuote(settings.Image), mode, shellQuote(managementURL), shellQuote(bootstrapURL), shellQuote(e.Hostname), shellQuote(e.ID), shellQuote(code), shellQuote(settings.Tags))
	dockerServe := fmt.Sprintf("%s docker run -d --name private-funnel-%s %s %s %s %s serve --management-url %s --hostname %s --state-dir /state --data-dir /data", dockerDirs, mode, dockerUser, volumeArgs, shellQuote(settings.Image), mode, shellQuote(managementURL), shellQuote(e.Hostname))
	if mode == "gateway" {
		dockerServe = fmt.Sprintf("%s docker run -d --name private-funnel-gateway -p 80:80 -p 443:443 %s %s %s gateway serve --management-url %s --hostname %s --state-dir /state --data-dir /data", dockerDirs, dockerUser, volumeArgs, shellQuote(settings.Image), shellQuote(managementURL), shellQuote(e.Hostname))
		if settings.CertEmail != "" {
			dockerServe += " --cert-email " + shellQuote(settings.CertEmail)
		}
	} else {
		dockerServe = fmt.Sprintf("%s docker run -d --name private-funnel-router %s --group-add \"$(stat -c '%%g' /var/run/docker.sock)\" -v /var/run/docker.sock:/var/run/docker.sock %s %s router serve --management-url %s --hostname %s --state-dir /state --data-dir /data", dockerDirs, dockerUser, volumeArgs, shellQuote(settings.Image), shellQuote(managementURL), shellQuote(e.Hostname))
		if settings.Ingress != "" {
			dockerServe = strings.Replace(dockerServe, "--group-add", "--network "+shellQuote(settings.Ingress)+" --group-add", 1)
			dockerServe += " --ingress-network " + shellQuote(settings.Ingress)
		}
	}
	instructions := []string{
		"Run the join command once on the target host, then run the generated serve command.",
		"Keep the state and data directories persistent so the Tailscale identity and certificates survive replacement.",
	}
	if mode == "gateway" {
		instructions = append(instructions, "Publish TCP ports 80 and 443 only on this gateway and point the configured gateway DNS A record at its public address.")
	} else {
		instructions = append(instructions,
			"Mount /var/run/docker.sock and attach the router and labeled HTTP containers to the configured ingress network.",
			"Every label hostname must match an enabled rule at /policies or the control service will reject the signed report without changing DNS.",
		)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"enrollment": e, "code": code, "command": command, "docker_join": dockerJoin, "docker_serve": dockerServe, "image": settings.Image, "instructions": instructions, "policy_url": "/policies", "label_example": `caddy=app.dev.example.com caddy.reverse_proxy={{upstreams 8080}}`})
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func (c *Control) enrollmentList(w http.ResponseWriter, r *http.Request) {
	mode := chi.URLParam(r, "mode")
	items, err := c.Store.Enrollments(mode)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(items)
}

func (c *Control) enrollmentRevoke(w http.ResponseWriter, r *http.Request) {
	if err := c.Store.RevokeEnrollment(chi.URLParam(r, "id")); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	_ = c.Store.Audit("enrollment.revoke:"+chi.URLParam(r, "id"), identityFromRequest(r))
	w.WriteHeader(http.StatusNoContent)
}

func (c *Control) enrollmentSigningKey(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	code := r.URL.Query().Get("code")
	var input struct {
		Code      string `json:"code"`
		PublicKey string `json:"public_key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err == nil {
		if code == "" {
			code = input.Code
		}
		if input.PublicKey != "" {
			input.PublicKey = strings.TrimSpace(input.PublicKey)
		}
	}
	e, err := c.Store.RedeemEnrollment(id, code)
	if err != nil {
		http.Error(w, "invalid enrollment", http.StatusForbidden)
		return
	}
	decodedKey, keyErr := base64.RawStdEncoding.DecodeString(input.PublicKey)
	if keyErr != nil || len(decodedKey) != ed25519.PublicKeySize {
		http.Error(w, "invalid Ed25519 key", 400)
		return
	}
	p := principal(r)
	if p.NodeID == "" {
		http.Error(w, "verified tailnet identity required", 403)
		return
	}
	// The revocable enrollment code proves possession of the intended
	// bootstrap command; the stable Tailscale identity is the binding stored
	// below. Hostnames can be suffixed by Tailscale when a name is already in
	// use, so they are not a safe identity key.
	if input.PublicKey == "" {
		http.Error(w, "public_key is required", 400)
		return
	}
	if err := c.Store.UpsertNodeEnrollment(id, id, e.Mode, e.Hostname); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if err := c.Store.BindNodeIdentity(id, input.PublicKey, p.NodeID, p.Addresses); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	_ = c.Store.Audit("enrollment.bind-key:"+id, identityFromRequest(r))
	w.WriteHeader(http.StatusNoContent)
}

func (c *Control) nodeList(w http.ResponseWriter, r *http.Request) {
	mode := chi.URLParam(r, "mode")
	if mode != "gateway" && mode != "router" {
		http.Error(w, "invalid mode", 400)
		return
	}
	nodes, err := c.Store.Nodes(mode)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(nodes)
}

func (c *Control) nodeRevoke(w http.ResponseWriter, r *http.Request) {
	if err := c.Store.RevokeNode(chi.URLParam(r, "id")); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	_ = c.Store.Audit("node.revoke:"+chi.URLParam(r, "id"), identityFromRequest(r))
	w.WriteHeader(http.StatusNoContent)
}
func render(w http.ResponseWriter, title, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := ui.Shell(title, body).Render(context.Background(), w); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func recordViews(records []libdns.Record) []map[string]any {
	out := make([]map[string]any, 0, len(records))
	for _, record := range records {
		rr := record.RR()
		out = append(out, map[string]any{"name": rr.Name, "type": rr.Type, "data": rr.Data})
	}
	return out
}

func (c *Control) operationsSync(w http.ResponseWriter, r *http.Request) {
	var in syncInput
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
		http.Error(w, "invalid sync request", http.StatusBadRequest)
		return
	}
	in.DryRun = true
	body, _ := json.Marshal(in)
	req := httptest.NewRequestWithContext(r.Context(), http.MethodPost, "/api/sync", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = WithPrincipal(req, principal(r))
	rr := httptest.NewRecorder()
	c.sync(rr, req)
	for key, values := range rr.Header() {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(rr.Code)
	_, _ = w.Write(rr.Body.Bytes())
}
