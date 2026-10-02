//go:build caddy

package proxy

import "testing"

func TestEmbeddedCaddyConfigValidates(t *testing.T) {
	for _, mode := range []string{"gateway", "router"} {
		if err := ValidateConfig(mode); err != nil {
			t.Fatalf("%s config: %v", mode, err)
		}
	}
}
