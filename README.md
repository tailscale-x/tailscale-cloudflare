# tailscale-cloudflare

A Cloudflare Worker that generates DNS records from Tailscale devices. It includes a public HTTP gateway using Caddy and a Tailscale daemon in one versioned Docker image.

## Configure the Worker

The Worker uses a Tailscale OAuth client for headless device reads and one-use gateway join keys. Create a client in Tailscale Trust credentials with `devices:core:read` and `auth_keys` scopes. Select only the tags that this Worker may assign. The API access token is renewed automatically; the OAuth client secret remains in Wrangler secrets.

```sh
npm ci
npx wrangler secret put TAILSCALE_OAUTH_CLIENT_ID
npx wrangler secret put TAILSCALE_OAUTH_CLIENT_SECRET
npm run deploy
```

Keep the local `wrangler.jsonc` owner ID and KV binding for this installation. The DNS owner ID must match the exact ID already used in Cloudflare record comments. Set the tailnet name and Cloudflare DNS token on the Worker Credentials page. The old Tailscale API key and webhook setup are no longer used. An hourly Cron and the manual Sync action update DNS. Worker deployment is manual; CI builds only the gateway image.

The Worker UI is public, including join-key creation. Anyone who can reach it can request a key with any tag authorized for the OAuth client. Tailscale device approval still applies if enabled in the tailnet. A one-use key expires after one day and is shown once. The Worker stores only its ID for revocation; revoking a key does not remove a node that has already joined. Remove joined nodes in Tailscale admin.

## Configure DNS exposure

Open **Task-Based DNS Generation → Gateway setup**. Enter the gateway's distinct Tailscale machine name, a gateway DNS hostname, and one or more Tailscale tags. Copy the one-use key to the server installer. Then add a **Gateway Exposure** task with the same machine name and gateway hostname, a backend machine selector, public and backend hostname templates, and an HTTP backend port.

The task creates DNS-only records:

| Record | Source | Purpose |
|---|---|---|
| Gateway A | The gateway node's one distinct public IPv4 endpoint | Public ingress |
| Public CNAME | Each selected backend | Points to the gateway hostname |
| `_gateway._tcp.<public-hostname>` SRV | Backend hostname and HTTP port | Caddy's request-specific upstream |
| Backend A | Backend's Tailscale IPv4 | Tailnet HTTP destination |

If the gateway is absent or has ambiguous public endpoints, sync reports an error, retains the last owned gateway A record, and reconciles other valid records. Deletion is limited to records bearing this Worker's exact ownership ID.

## Deploy the gateway

The installer uses `docker run`. If Docker is missing, it runs the Docker installation script and adds the invoking user to the `docker` group. Start a fresh login afterward to use Docker without `sudo`.

```sh
curl -fsSL https://raw.githubusercontent.com/tailscale-x/tailscale-cloudflare/main/gateway/install.sh | sh
```

The script prompts for the gateway machine name, certificate contact email, and a one-use join key. You can pass `--hostname`, `--email`, `--image`, and `--dns` after `sh -s --` to automate non-secret settings. It runs the versioned image with persistent named volumes and removes the temporary join-key file after successful Tailscale login. The installer uses `9.9.9.9` for public DNS by default because the host's Tailscale resolver may have no upstream DNS server; use `--dns` to select another resolver. The gateway image contains its fixed Caddyfile; no Worker, Cloudflare, or Tailscale API credential is sent to Caddy.

On the existing VPS, the script stops the old sidecar and reuses its `tailscale-cloudflare-gateway_tailscale_state` volume. It keeps the old container available until the new gateway joins. New servers use the same volume names for Tailscale state and Caddy data. The image must be public on GHCR for an unauthenticated first-time pull.

After joining, sync the Worker and check the A, CNAME, SRV, and backend A records before sending public traffic. Caddy uses `_gateway._tcp.{host}` to choose the HTTP backend, redirects HTTP to HTTPS, and obtains public certificates on demand. Its local permission endpoint allows certificate attempts for any hostname reaching Caddy; ACME validation still controls issuance. A hostname without SRV has no upstream.

To update or roll back, run the installer again with `--image` set to the desired published tag. Existing non-secret settings are loaded from the server-local settings file; `--reuse-state` skips the join-key prompt:

```sh
curl -fsSL https://raw.githubusercontent.com/tailscale-x/tailscale-cloudflare/main/gateway/install.sh | sh -s -- --image ghcr.io/tailscale-x/tailscale-cloudflare-caddy:v0.1.2 --reuse-state
```

The same named volumes preserve the node identity and certificates. The image workflow validates the Caddyfile and installer on `main` and publishes `ghcr.io/tailscale-x/tailscale-cloudflare-caddy:<version-tag>` on version tags.
