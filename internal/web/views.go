package web

import (
	"encoding/json"
	"fmt"
	"html/template"
	"strconv"
	"strings"
	"time"
)

func safeText(value string) string { return template.HTMLEscapeString(value) }

func unixLabel(value int64) string {
	if value <= 0 {
		return "—"
	}
	return time.Unix(value, 0).UTC().Format("02 Jan 2006 · 15:04 UTC")
}

func pill(label, tone string) string {
	return fmt.Sprintf(`<span class="pf-pill pf-pill-%s"><i class="pf-status-dot pf-status-%s"></i>%s</span>`, safeText(tone), safeText(tone), safeText(label))
}

func pageIntro(kicker, title, subtitle string) string {
	return fmt.Sprintf(`<div class="pf-page-intro"><div><p class="pf-kicker">%s</p><h1 class="pf-title">%s</h1><p class="pf-subtitle">%s</p></div></div>`, safeText(kicker), safeText(title), safeText(subtitle))
}

func reportExposureCount(payloads map[string]string) int {
	count := 0
	for _, payload := range payloads {
		var envelope struct {
			Payload json.RawMessage `json:"payload"`
		}
		if json.Unmarshal([]byte(payload), &envelope) == nil && len(envelope.Payload) > 0 {
			var report struct {
				Exposures []json.RawMessage `json:"exposures"`
			}
			if json.Unmarshal(envelope.Payload, &report) == nil {
				count += len(report.Exposures)
				continue
			}
		}
		var report struct {
			Exposures []json.RawMessage `json:"exposures"`
		}
		if json.Unmarshal([]byte(payload), &report) == nil {
			count += len(report.Exposures)
		}
	}
	return count
}

func stringValue(values map[string]any, key, fallback string) string {
	if value, ok := values[key].(string); ok && strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}

func intValue(values map[string]any, key string) int {
	switch value := values[key].(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	case string:
		parsed, _ := strconv.Atoi(value)
		return parsed
	default:
		return 0
	}
}
