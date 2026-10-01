# tailscale-cloudflare

The Worker manages DNS-only Cloudflare records for a public Caddy gateway and Docker routers on a tailnet. One versioned Caddy image embeds a persistent Tailscale node in either mode. It pins Caddy 2.11.4, `caddy-tailscale`, and `caddy-docker-proxy/v2` in [the Go module](node/go/go.mod). The small local proxy fork calls an exposure hook after successful config reloads; Docker discovery, upstream selection, and reloads are upstream behavior.

## Worker setup

Configure a Tailscale OAuth client with `devices:core:read`, `auth_keys` write, and `devices:core` if joined-device revocation is wanted. Allow only the tags the UI may assign. Set the Cloudflare token and tailnet on the Credentials page. Keep `DNS_RECORD_OWNER_ID` and the KV namespace in the server-local `wrangler.jsonc`. The OAuth client ID and secret remain Wrangler secrets:

```sh
npm ci
npx wrangler secret put TAILSCALE_OAUTH_CLIENT_ID
npx wrangler secret put TAILSCALE_OAUTH_CLIENT_SECRET
npm run deploy
```

The management UI remains public. Create a Gateway or Router node there to obtain a one-hour enrollment code. The installer makes Ed25519 signing and X25519 exchange keys locally. The Worker creates a one-use Tailscale auth key using OAuth and encrypts it to the installer. The enrollment code is removed from KV after redemption on a best-effort basis; KV alone cannot guarantee atomic redemption across concurrent Worker locations. Revocation disables reports and DNS publication and attempts to remove the joined Tailscale device. Router reports expire after ten minutes. DNS reconciliation touches only records bearing this Worker's exact ownership ID.

## Install

On the target Docker host, use the same installer and image for both modes:

```sh
sh node/install.sh --role gateway --worker https://YOUR-WORKER.example --email YOU@example.com
sh node/install.sh --role router --worker https://YOUR-WORKER.example
```

Enter the enrollment code when prompted. The installer uses the pinned `ghcr.io/tailscale-x/tailscale-cloudflare-caddy:v0.2.1` image, or `--image ghcr.io/tailscale-x/tailscale-cloudflare-caddy:vX.Y.Z` for an update or rollback. It installs Docker with `curl -fsSL https://get.docker.com | sh` if necessary and adds the invoking user to the Docker group. Log in again to use Docker without `sudo`. The gateway publishes TCP 80/443 and persists Caddy certificates under `/data` and Tailscale state under `/state`. The router mounts the Docker socket, publishes no host ports, and persists Tailscale state. Both use direct `docker run`. No TUN device or host Tailscale daemon is required.

The gateway uses its single unambiguous public IPv4 endpoint for its A record. A missing or ambiguous endpoint reports a sync error and keeps the previous A record. Caddy terminates HTTPS, redirects HTTP, looks up `_gateway._tcp.{host}`, and uses embedded Tailscale outbound transport to the HTTP backend. Its local certificate permission endpoint permits any hostname that passes ACME validation.

## Docker router and ingress network

The installer creates `tailscale-cloudflare-ingress` and attaches the router to it. Attach every exposed HTTP service to this network as well. `caddy-docker-proxy` does **not** attach the router to arbitrary service networks. For Compose:

```yaml
services:
  app:
    image: your-app:version
    networks: [ingress]
    labels:
      caddy: "http://app.example.com:8080"
      caddy.bind: "tailscale/router"
      caddy.reverse_proxy: "{{upstreams 3000}}"
networks:
  ingress:
    external: true
    name: tailscale-cloudflare-ingress
```

The hostname is the public alias; `3000` is the container's HTTP port. The router accepts tailnet HTTP on port 8080 and proxies to the container IP selected by `{{upstreams 3000}}`. The Worker publishes the alias CNAME, SRV target, and DNS-only router tailnet A record from signed router reports. All exposed services should use the same `caddy` site pattern above. Containers on other networks cannot be reached. The Docker socket grants broad host control, so install the router only on a trusted Docker host.

## Release and rollback

CI builds the single image, adapts both fixed Caddyfiles, and tests Docker label routing across the dedicated ingress network on `main`; a `v*` tag publishes it to GHCR. The Worker is deployed manually with Wrangler. For rollback, rerun the installer with the previous image tag. The persistent volumes retain both node identity and gateway certificates. Before moving public traffic, verify two aliases with different SRV targets, missing SRV, backend failure, HTTP redirect, first-visit HTTPS, and identity after container replacement. The pinned Tailscale plugin panics during `caddy validate` cleanup before a node starts; use `caddy adapt` offline and a live startup test.
