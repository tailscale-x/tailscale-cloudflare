// Package policy contains the control-plane rules for router exposure.
package policy

import (
	"fmt"
	"net/netip"
	"regexp"
	"strings"
)

// Rule grants a set of Tailscale principals permission to publish hostnames
// matching HostnameRegex through one or more gateways. HostnameRegex is
// matched against the complete, lower-case hostname.
type Rule struct {
	Name             string   `json:"name"`
	HostnameRegex    string   `json:"hostname_regex"`
	Roles            []string `json:"roles"`
	RouterIDs        []string `json:"router_ids"`
	GatewayHostnames []string `json:"gateway_hostnames"`
	Enabled          bool     `json:"enabled"`
}

// Document is persisted by the control service. An empty document denies all
// router exposure, which makes adding a router safe until an administrator
// explicitly creates a matching rule.
type Document struct {
	Rules []Rule `json:"rules"`
}

func (d Document) Validate() error {
	if len(d.Rules) > 200 {
		return fmt.Errorf("at most 200 exposure policy rules are supported")
	}
	for i, rule := range d.Rules {
		if len(rule.HostnameRegex) > 2048 {
			return fmt.Errorf("policy rule %d hostname regex is too long", i+1)
		}
		if strings.TrimSpace(rule.HostnameRegex) == "" {
			return fmt.Errorf("policy rule %d has no hostname_regex", i+1)
		}
		if _, err := regexp.Compile("^(?:" + rule.HostnameRegex + ")$"); err != nil {
			return fmt.Errorf("policy rule %d has invalid hostname_regex: %w", i+1, err)
		}
		if len(nonEmpty(rule.Roles)) == 0 && len(nonEmpty(rule.RouterIDs)) == 0 {
			return fmt.Errorf("policy rule %d must select at least one role or router", i+1)
		}
	}
	return nil
}

// Allows returns whether one enabled rule authorizes this router, hostname,
// and gateway. Any matching role or router selector is sufficient.
func (d Document) Allows(hostname, gateway string, routerIDs, roles []string) (bool, string) {
	if rule, ok := d.Match(hostname, gateway, routerIDs, roles); ok {
		name := rule.Name
		if name == "" {
			name = rule.HostnameRegex
		}
		return true, name
	}
	return false, ""
}

// Match returns the first matching rule; rule order makes the provider choice
// deterministic. Router IDs are stable identifiers and remain case sensitive.
func (d Document) Match(hostname, gateway string, routerIDs, roles []string) (Rule, bool) {
	hostname = normalize(hostname)
	gateway = normalize(gateway)
	if ValidateHostname(hostname) != nil || ValidateHostname(gateway) != nil {
		return Rule{}, false
	}
	routerSet := map[string]bool{}
	for _, id := range routerIDs {
		routerSet[strings.TrimSpace(id)] = true
	}
	roleSet := set(roles)
	for _, rule := range d.Rules {
		if !rule.Enabled {
			continue
		}
		matched, err := regexp.MatchString("^(?:"+rule.HostnameRegex+")$", hostname)
		if err != nil || !matched {
			continue
		}
		if len(nonEmpty(rule.GatewayHostnames)) > 0 && !containsNormalized(rule.GatewayHostnames, gateway) {
			continue
		}
		roleOK := false
		for _, role := range nonEmpty(rule.Roles) {
			if role == "*" || roleSet[normalize(role)] {
				roleOK = true
				break
			}
		}
		routerOK := false
		for _, id := range nonEmpty(rule.RouterIDs) {
			if id == "*" || routerSet[id] {
				routerOK = true
				break
			}
		}
		if roleOK || routerOK {
			return rule, true
		}
	}
	return Rule{}, false
}

// ValidateHostname deliberately accepts DNS hostnames rather than URLs, IPs,
// wildcard names or Caddy expressions. International names use their ASCII
// punycode form so one canonical string is used for policy and DNS.
func ValidateHostname(hostname string) error {
	hostname = normalize(hostname)
	if _, err := netip.ParseAddr(hostname); err == nil {
		return fmt.Errorf("an IP address is not a DNS hostname")
	}
	if len(hostname) > 253 || !strings.Contains(hostname, ".") {
		return fmt.Errorf("a complete DNS hostname is required")
	}
	for _, label := range strings.Split(hostname, ".") {
		if len(label) < 1 || len(label) > 63 || !hostnameLabel.MatchString(label) {
			return fmt.Errorf("invalid DNS hostname %q", hostname)
		}
	}
	return nil
}

var hostnameLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)

func nonEmpty(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			out = append(out, value)
		}
	}
	return out
}

func normalize(value string) string {
	return strings.ToLower(strings.TrimSuffix(strings.TrimSpace(value), "."))
}

func set(values []string) map[string]bool {
	out := make(map[string]bool, len(values))
	for _, value := range values {
		if value = normalize(value); value != "" {
			out[value] = true
		}
	}
	return out
}

func containsNormalized(values []string, want string) bool {
	for _, value := range values {
		if normalize(value) == want {
			return true
		}
	}
	return false
}
