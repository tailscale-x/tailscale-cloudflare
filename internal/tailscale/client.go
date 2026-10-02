package tailscale

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

type Client struct {
	HTTP                            *http.Client
	ClientID, ClientSecret, Tailnet string
}
type authKeyRequest struct {
	Capabilities  map[string]any `json:"capabilities"`
	Description   string         `json:"description"`
	ExpirySeconds int            `json:"expirySeconds"`
}
type authKeyResponse struct {
	Key string `json:"key"`
}

func (c Client) CreateAuthKey(ctx context.Context, mode, hostname string, tags []string) (string, error) {
	tokenReq := url.Values{"client_id": {c.ClientID}, "client_secret": {c.ClientSecret}, "grant_type": {"client_credentials"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://login.tailscale.com/api/v2/oauth/token", strings.NewReader(tokenReq.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := c.client().Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return "", fmt.Errorf("Tailscale OAuth token: HTTP %d", res.StatusCode)
	}
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&token); err != nil {
		return "", err
	}
	body, _ := json.Marshal(authKeyRequest{
		Description:   "tailscale-private-funnel-" + mode + "-" + hostname,
		ExpirySeconds: 3600,
		Capabilities: map[string]any{
			"devices": map[string]any{
				"create": map[string]any{
					// The auth key is one-use and short-lived, but the node must not be
					// ephemeral: an ephemeral node is removed when its container stops,
					// which changes the WhoIs identity on restart despite persistent
					// tsnet state and invalidates the enrolled report binding.
					"reusable": false, "ephemeral": false, "preauthorized": true, "tags": tags,
				},
			},
		},
	})
	endpoint := "https://api.tailscale.com/api/v2/tailnet/" + url.PathEscape(c.Tailnet) + "/keys"
	req, err = http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	res, err = c.client().Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return "", fmt.Errorf("Tailscale auth key: HTTP %d", res.StatusCode)
	}
	var key authKeyResponse
	if err := json.NewDecoder(res.Body).Decode(&key); err != nil {
		return "", err
	}
	if key.Key == "" {
		return "", fmt.Errorf("Tailscale returned an empty auth key")
	}
	return key.Key, nil
}

func (c Client) client() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}
