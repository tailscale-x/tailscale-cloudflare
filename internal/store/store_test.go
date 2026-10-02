package store

import (
	"encoding/json"
	"github.com/libdns/libdns"
	"github.com/tailscale-x/tailscale-private-funnel/internal/report"
	"testing"
	"time"
)

func TestProviderConfigIsEncryptedAndRoundTrips(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.SaveProvider("dev", "cloudflare", "example.com", map[string]string{"api_token": "secret"}, true); err != nil {
		t.Fatal(err)
	}
	p, config, err := s.ProviderConfig("dev")
	if err != nil {
		t.Fatal(err)
	}
	if p.Provider != "cloudflare" || config["api_token"] != "secret" {
		t.Fatalf("provider=%+v config=%v", p, config)
	}
	if err := s.ReplaceLedger("dev", "example.com", "owner", []libdns.Record{libdns.RR{Name: "app", Type: "A", Data: "100.64.0.2", TTL: time.Minute}}); err != nil {
		t.Fatal(err)
	}
	entries, err := s.Ledger("dev", "example.com", "owner")
	if err != nil || len(entries) != 1 {
		t.Fatalf("entries=%v err=%v", entries, err)
	}
}

func TestAcceptReportRequiresEnrolledSigningKey(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	pub, priv, err := report.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	e, err := report.NewEnvelope("router-1", map[string]any{"exposures": []any{}}, pub, priv, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(e)
	if err := s.AcceptReport(e.NodeID, e.Nonce, b, e.PublicKey); err == nil {
		t.Fatal("unknown node report was accepted")
	}
	if err := s.UpsertNode("router-1", "router", "router-1"); err != nil {
		t.Fatal(err)
	}
	if err := s.BindNodeKey("router-1", e.PublicKey); err != nil {
		t.Fatal(err)
	}
	if err := s.AcceptReport(e.NodeID, e.Nonce, b, e.PublicKey); err != nil {
		t.Fatal(err)
	}
	if err := s.AcceptReport(e.NodeID, e.Nonce, b, e.PublicKey); err == nil {
		t.Fatal("replayed report was accepted")
	}
}

func TestEnrollmentIsReusableUntilRevoked(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil { t.Fatal(err) }
	defer s.Close()
	e, code, err := s.CreateEnrollment("router", "router-node")
	if err != nil { t.Fatal(err) }
	if _, err := s.RedeemEnrollment(e.ID, code); err != nil { t.Fatal(err) }
	if _, err := s.RedeemEnrollment(e.ID, code); err != nil { t.Fatal(err) }
	if err := s.RevokeEnrollment(e.ID); err != nil { t.Fatal(err) }
	if _, err := s.RedeemEnrollment(e.ID, code); err == nil { t.Fatal("revoked enrollment was accepted") }
}
