package dns

import "testing"

func TestRouterRecords(t *testing.T) {
	recs, err := RouterRecords(RouterExposure{PublicHostname: "app.example", BackendHostname: "app.backend", BackendIP: "100.64.0.2", GatewayHostname: "gateway.example", Port: 8080})
	if err != nil || len(recs) != 3 {
		t.Fatalf("records=%v err=%v", recs, err)
	}
	if got := recs[1].RR().Data; got != "1 1 8080 app.backend" {
		t.Fatalf("srv=%q", got)
	}
}

func TestGatewayAmbiguousEndpoint(t *testing.T) {
	if _, preserve, err := GatewayRecord(GatewayEndpoint{Hostname: "gateway.example", PublicIPv4: []string{"1.2.3.4", "5.6.7.8"}}); err == nil || !preserve {
		t.Fatalf("expected preserve error, got err=%v preserve=%v", err, preserve)
	}
}
