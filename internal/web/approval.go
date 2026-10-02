package web

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/libdns/libdns"
	"github.com/tailscale-x/tailscale-private-funnel/internal/dns"
)

// Approvals are bound to the exact provider, owner, desired records, live DNS,
// and ledger snapshot. They are not stored as a permanent overwrite setting.
func (c *Control) approval(providerID, ownerID string, desired, existing []libdns.Record, ledger []dns.LedgerEntry, token string) (string, error) {
	key, err := c.Store.GetSecret("dns_approval_signing_key")
	if err != nil {
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return "", err
		}
		key = base64.RawURLEncoding.EncodeToString(raw)
		if err := c.Store.SetSecret("dns_approval_signing_key", key); err != nil {
			return "", err
		}
	}
	snapshot := []string{providerID, ownerID}
	for _, record := range desired {
		snapshot = append(snapshot, "desired:"+dns.RecordKey(record)+fmt.Sprint(record.RR().TTL))
	}
	for _, record := range existing {
		snapshot = append(snapshot, "existing:"+dns.RecordKey(record)+fmt.Sprint(record.RR().TTL))
	}
	for _, entry := range ledger {
		snapshot = append(snapshot, "ledger:"+entry.OwnerID+":"+dns.RecordKey(entry.Record))
	}
	sort.Strings(snapshot)
	payload, _ := json.Marshal(snapshot)
	deadline := time.Now().Add(10 * time.Minute).Unix()
	if token != "" {
		parts := strings.Split(token, ".")
		if len(parts) != 2 {
			return "", fmt.Errorf("overwrite approval is invalid; preview again")
		}
		deadline, err = strconv.ParseInt(parts[0], 10, 64)
		if err != nil || deadline < time.Now().Unix() || deadline > time.Now().Add(10*time.Minute).Unix() {
			return "", fmt.Errorf("overwrite approval expired; preview again")
		}
	}
	prefix := strconv.FormatInt(deadline, 10)
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(prefix))
	mac.Write(payload)
	expected := prefix + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if token != "" && !hmac.Equal([]byte(token), []byte(expected)) {
		return "", fmt.Errorf("overwrite approval no longer matches DNS or ledger; preview again")
	}
	return expected, nil
}
