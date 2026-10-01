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

Install Docker on the Ubuntu server and ensure `ubuntu` has Docker access from a new login:

```sh
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu
```

Copy [`gateway/`](gateway/) to the server. Run `./install.sh` there. On first run it writes a private `.env.example` copy and asks you to edit the machine name, certificate contact email, and versioned image tag. On the second run it prompts for the one-use join key, mounts it as a private file for first boot, and deletes the file after the node joins. The gateway image contains its fixed Caddyfile; no Worker, Cloudflare, or Tailscale API credential is sent to Caddy.

Use the same Compose project name and named volumes when replacing the previous sidecar stack. Stop the old stack with `docker compose down` and retain its volumes. The new single service reuses `tailscale_state`, `caddy_data`, and `caddy_config`. Do not run old and new stacks on ports 80/443 simultaneously.

After joining, sync the Worker and check the A, CNAME, SRV, and backend A records before sending public traffic. Caddy uses `_gateway._tcp.{host}` to choose the HTTP backend, redirects HTTP to HTTPS, and obtains public certificates on demand. Its local permission endpoint allows certificate attempts for any hostname reaching Caddy; ACME validation still controls issuance. A hostname without SRV has no upstream.

To update or roll back, edit `CADDY_IMAGE` in the server-local `.env` to the desired published tag and run:

```sh
docker compose -f compose.yaml pull gateway
docker compose -f compose.yaml up -d gateway
```

The same named volumes preserve the node identity and certificates. The image workflow validates the Caddyfile and Compose configuration on `main` and publishes `ghcr.io/tailscale-x/tailscale-cloudflare-caddy:<version-tag>` on version tags.
