package policy

import "testing"

func TestEmptyPolicyDenies(t *testing.T) {
	if ok, _ := (Document{}).Allows("app.example.com", "gw.example.com", []string{"router-1"}, []string{"tag:router"}); ok {
		t.Fatal("empty policy must deny exposure")
	}
}

func TestRuleMatchesFullHostnameAndRole(t *testing.T) {
	d := Document{Rules: []Rule{{Name: "dev", HostnameRegex: `[^.]+\.dev\.example\.com`, Roles: []string{"group:platform"}, GatewayHostnames: []string{"gateway.example.com"}, Enabled: true}}}
	if err := d.Validate(); err != nil {
		t.Fatal(err)
	}
	if ok, _ := d.Allows("api.dev.example.com.", "gateway.example.com.", []string{"router-1"}, []string{"group:platform"}); !ok {
		t.Fatal("matching role and gateway should be allowed")
	}
	if ok, _ := d.Allows("api.prod.example.com", "gateway.example.com", []string{"router-1"}, []string{"group:platform"}); ok {
		t.Fatal("hostname outside the rule should be denied")
	}
}

func TestRuleRequiresPrincipalSelector(t *testing.T) {
	if err := (Document{Rules: []Rule{{HostnameRegex: `.*`, Enabled: true}}}).Validate(); err == nil {
		t.Fatal("a rule without role or router selector must be rejected")
	}
}

func TestRuleRejectsNonDNSHostnameAtMatch(t *testing.T) {
	d := Document{Rules: []Rule{{HostnameRegex: `.*`, RouterIDs: []string{"router-1"}, Enabled: true}}}
	if ok, _ := d.Allows("*.example.com", "gateway.example.com", []string{"router-1"}, nil); ok {
		t.Fatal("wildcard hostname must not be auto-provisioned")
	}
	if ok, _ := d.Allows("192.0.2.1", "gateway.example.com", []string{"router-1"}, nil); ok {
		t.Fatal("IP address must not be auto-provisioned as a DNS name")
	}
}
