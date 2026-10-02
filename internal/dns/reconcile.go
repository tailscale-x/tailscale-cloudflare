package dns

import (
	"fmt"
	"strings"

	"github.com/libdns/libdns"
)

// OwnershipPlan validates every affected record set before any provider write.
// An explicit override applies only after a user-approved preview. Without it,
// records outside the current owner are never touched, including identical
// records; silently adopting one would allow later cleanup to delete it.
func OwnershipPlan(ownerID string, ledger []LedgerEntry, existing, desired []libdns.Record, allowUnowned bool) (add, remove []libdns.Record, err error) {
	if strings.TrimSpace(ownerID) == "" {
		return nil, nil, fmt.Errorf("owner ID is required")
	}
	owners := map[string]map[string]bool{}
	for _, entry := range ledger {
		key := RecordKey(entry.Record)
		if owners[key] == nil {
			owners[key] = map[string]bool{}
		}
		owners[key][entry.OwnerID] = true
	}
	wanted, present := map[string]bool{}, map[string]bool{}
	for _, record := range existing {
		present[RecordKey(record)] = true
	}
	for _, record := range desired {
		key := RecordKey(record)
		if wanted[key] {
			continue
		}
		wanted[key] = true
		for other := range owners[key] {
			if other != ownerID && !allowUnowned {
				return nil, nil, fmt.Errorf("record ownership conflict for %s: owned by %s", record.RR().Name, other)
			}
		}
		if !present[key] {
			add = append(add, record)
		}
		if present[key] && !owners[key][ownerID] && !allowUnowned {
			return nil, nil, fmt.Errorf("unowned provider record exists for %s; explicit allow_unowned permission is required", record.RR().Name)
		}
	}
	for _, entry := range ledger {
		key := RecordKey(entry.Record)
		if entry.OwnerID == ownerID && present[key] && !wanted[key] {
			remove = append(remove, entry.Record)
		}
	}
	// Setters/deleters can operate on whole name/type sets. Check their siblings
	// as well; a CNAME additionally conflicts with every other type at its name.
	touched := append(append([]libdns.Record{}, add...), remove...)
	// A setter replaces the whole name/type RRset. Even an already-owned
	// desired value therefore touches unowned siblings and must be rejected
	// unless the caller explicitly authorizes that overwrite.
	touched = append(touched, desired...)
	removed := map[string]bool{}
	for _, record := range remove {
		removed[RecordKey(record)] = true
	}
	for _, current := range existing {
		conflicts := false
		for _, change := range touched {
			a, b := current.RR(), change.RR()
			if strings.EqualFold(strings.TrimSuffix(a.Name, "."), strings.TrimSuffix(b.Name, ".")) && (strings.EqualFold(a.Type, b.Type) || strings.EqualFold(a.Type, "CNAME") || strings.EqualFold(b.Type, "CNAME")) {
				conflicts = true
				break
			}
		}
		if !conflicts {
			continue
		}
		key := RecordKey(current)
		for other := range owners[key] {
			if other != ownerID && !allowUnowned {
				return nil, nil, fmt.Errorf("record ownership conflict for %s: owned by %s", current.RR().Name, other)
			}
		}
		if owners[key][ownerID] {
			continue
		}
		if !allowUnowned {
			return nil, nil, fmt.Errorf("unowned provider record exists for %s; explicit allow_unowned permission is required", current.RR().Name)
		}
		if !wanted[key] && !removed[key] {
			remove = append(remove, current)
			removed[key] = true
		}
	}
	return add, remove, nil
}

// LedgerEntry ties a provider record to this installation's ownership ID. The
// ledger is the source of truth for deletion; records without a matching owner
// are never removed by reconciliation.
type LedgerEntry struct {
	Record  libdns.Record
	OwnerID string
}

// Plan returns provider changes for one ownership-scoped reconciliation. It
// adds desired records and removes only ledger records belonging to ownerID
// that are no longer desired.
func Plan(ownerID string, ledger []LedgerEntry, desired []libdns.Record) (add, remove []libdns.Record) {
	desiredSet := make(map[string]struct{}, len(desired))
	for _, record := range desired {
		desiredSet[recordKey(record)] = struct{}{}
	}
	ownedSet := make(map[string]struct{})
	for _, entry := range ledger {
		if entry.OwnerID != ownerID {
			continue
		}
		key := recordKey(entry.Record)
		ownedSet[key] = struct{}{}
		if _, ok := desiredSet[key]; !ok {
			remove = append(remove, entry.Record)
		}
	}
	for _, record := range desired {
		if _, ok := ownedSet[recordKey(record)]; !ok {
			add = append(add, record)
		}
	}
	return add, remove
}

func recordKey(record libdns.Record) string {
	return RecordKey(record)
}

// RecordKey normalizes provider formatting so an existing provider record can
// be adopted into the ownership ledger without attempting a duplicate append.
func RecordKey(record libdns.Record) string {
	rr := record.RR()
	return strings.ToLower(strings.TrimSuffix(rr.Name, ".")) + "\x00" + strings.ToUpper(rr.Type) + "\x00" + strings.TrimSuffix(strings.TrimSpace(rr.Data), ".")
}
