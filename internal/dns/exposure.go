package dns

import (
	"fmt"
	"net/netip"
	"strings"
	"time"

	"github.com/libdns/libdns"
)

type RouterExposure struct {
	PublicHostname  string `json:"public_hostname"`
	BackendHostname string `json:"backend_hostname"`
	BackendIP       string `json:"backend_ip"`
	GatewayHostname string `json:"gateway_hostname"`
	Port            uint16 `json:"port"`
}

func RouterRecords(e RouterExposure) ([]libdns.Record, error) {
	if e.PublicHostname == "" || e.BackendHostname == "" || e.GatewayHostname == "" || e.Port == 0 {
		return nil, fmt.Errorf("public hostname, backend hostname, gateway hostname, and port are required")
	}
	ip, err := netip.ParseAddr(e.BackendIP)
	if err != nil || !ip.Is4() {
		return nil, fmt.Errorf("backend IP must be a Tailscale IPv4 address")
	}
	name := strings.TrimSuffix(e.PublicHostname, ".")
	return []libdns.Record{
		libdns.RR{Name: name, Type: "CNAME", Data: strings.TrimSuffix(e.GatewayHostname, "."), TTL: 60 * time.Second},
		libdns.SRV{Service: "gateway", Transport: "tcp", Name: name, Priority: 1, Weight: 1, Port: e.Port, Target: strings.TrimSuffix(e.BackendHostname, "."), TTL: 60 * time.Second},
		libdns.RR{Name: strings.TrimSuffix(e.BackendHostname, "."), Type: "A", Data: ip.String(), TTL: 60 * time.Second},
	}, nil
}

type GatewayEndpoint struct {
	Hostname   string   `json:"hostname"`
	PublicIPv4 []string `json:"public_ipv4"`
}

func GatewayRecord(e GatewayEndpoint) (libdns.Record, bool, error) {
	if e.Hostname == "" {
		return nil, false, fmt.Errorf("gateway hostname is required")
	}
	if len(e.PublicIPv4) != 1 {
		return nil, true, fmt.Errorf("gateway requires one unambiguous public IPv4 endpoint")
	}
	ip, err := netip.ParseAddr(e.PublicIPv4[0])
	if err != nil || !ip.Is4() {
		return nil, true, fmt.Errorf("gateway endpoint must be IPv4")
	}
	return libdns.RR{Name: strings.TrimSuffix(e.Hostname, "."), Type: "A", Data: ip.String(), TTL: 60 * time.Second}, false, nil
}
