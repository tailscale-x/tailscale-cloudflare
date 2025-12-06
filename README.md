# Tailscale to Cloudflare DNS Sync

A Cloudflare Worker that automatically syncs DNS records from Tailscale machines to Cloudflare DNS. Each machine creates A records across three configurable domains (Tailscale, WAN, and LAN) with ownership validation using DNS record comments.

## Features

- **Webhook Integration**: Real-time DNS updates when machines are added, updated, or deleted in Tailscale
- **Cron Sync**: Hourly full synchronization to ensure perfect sync
- **IP Classification**: Automatically classifies IPs as LAN (private) or WAN (public) based on CIDR ranges
- **Tag Filtering**: Filter devices by Tailscale tags using regex patterns (optional)
- **Cloudflare Proxy**: Enable Cloudflare proxy (orange cloud) for devices based on tag regex patterns (optional)
- **Ownership Validation**: Uses DNS record comments to track ownership and prevent conflicts
- **Batch Operations**: Efficient batch API usage for Cloudflare free plan (200 records per batch)

## Architecture

### DNS Record Structure

For each machine `<machine-name>`:
- `<machine-name>.<ts-domain>` → A record → Tailscale IP
- `<machine-name>.<wan-domain>` → A record → WAN IP (public IP ranges)
- `<machine-name>.<lan-domain>` → A record → LAN IP (private IP ranges)
- Each A record includes an ownership comment for tracking and validation

### Ownership Comment Format

DNS records use Cloudflare's comment field for ownership tracking:
- **Format**: `cf-ts-dns:<owner-id>:<machine-name>`
- **Example**: `cf-ts-dns:cloudflare-tailscale-dns:my-machine`
- **Purpose**: Identifies which records are managed by this service and prevents conflicts
- **Limitation**: Comments are truncated to 100 characters to comply with Cloudflare's API limits

### IP Classification

The worker extracts IP addresses from Tailscale device endpoints and classifies them:

- **LAN IPs**: Private/internal CIDR ranges
  - 10.0.0.0/8 (10.0.0.0 - 10.255.255.255)
  - 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
  - 192.168.0.0/16 (192.168.0.0 - 192.168.255.255)
  - 100.64.0.0/10 (100.64.0.0 - 100.127.255.255) - Carrier-Grade NAT

- **WAN IPs**: All other IPs (public IP ranges)
- **Tailscale IPs**: IPs from Tailscale's assigned address space (typically 100.x.y.z)

**Important**: The `LAN_CIDR_RANGES` configuration is ordered. When a device has multiple endpoints that match different CIDR ranges, the endpoint matching the **first range** in the ordered list is chosen as the LAN IP. This allows you to prioritize specific ranges by placing them earlier in the comma-separated list.

For example, if `LAN_CIDR_RANGES` is set to `"192.168.0.0/16,10.0.0.0/8"` and a device has endpoints `192.168.1.1:12345` and `10.0.0.1:54321`, the endpoint `192.168.1.1` will be selected because it matches the first range (`192.168.0.0/16`).

## Prerequisites

1. **Tailscale Account** with API access
2. **Cloudflare Account** with DNS zone
3. **Cloudflare API Token** with DNS edit permissions
4. **Node.js** and **npm** installed

## Setup Instructions

### 1. Prerequisites

- Tailscale account with API access
- Cloudflare account with DNS zone
- Node.js and npm installed

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

See [`.env.example`](.env.example) for all required and optional environment variables with detailed descriptions.

**Configure environment variables via Cloudflare Dashboard:**

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **Workers & Pages** → Your Worker → **Settings** → **Variables**
3. Configure the following:

**Required Variables:**
- `TAILSCALE_TAILNET`: Your Tailscale tailnet name
- `CLOUDFLARE_ZONE_ID`: Your Cloudflare Zone ID
- `DOMAIN_FOR_TAILSCALE_ENDPOINT`: Domain for Tailscale endpoint records (e.g., "ts.example.com")
- `DOMAIN_FOR_WAN_ENDPOINT`: Domain for WAN endpoint records (e.g., "wan.example.com")
- `DOMAIN_FOR_LAN_ENDPOINT`: Domain for LAN endpoint records (e.g., "lan.example.com")
- `LAN_CIDR_RANGES`: Comma-separated CIDR ranges for Private-Use Networks [RFC1918] (e.g., "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"). **Order matters**: When a device has multiple endpoints matching different ranges, the endpoint matching the first range in the list is chosen as the LAN IP.
- `TAILSCALE_TAG_FILTER_REGEX`: Regular expression to filter devices by tags (e.g., "^tag:dns" to only sync devices with tags starting with "tag:dns")
- `TAILSCALE_TAG_PROXY_REGEX`: Regular expression to enable Cloudflare proxy for WAN domain records (e.g., "^tag:proxy" to enable proxy for WAN records of devices with tags starting with "tag:proxy"). Note: Only WAN records can be proxied; TS and LAN records are always DNS-only.

**Required Secrets:**
- `TAILSCALE_API_KEY`: Tailscale API key (starts with "tskey-api-")
- `CLOUDFLARE_API_TOKEN`: Cloudflare API token (minimum 40 characters)

**Optional Variables** (leave empty for defaults):
- `DNS_RECORD_OWNER_ID`: DNS record owner identifier (defaults to "cloudflare-tailscale-dns")

**Optional Secrets:**
- `TAILSCALE_WEBHOOK_SECRET`: Secret for validating webhook signatures (if using webhook validation)

See `.env.example` for detailed descriptions.

### 4. Configure Tailscale Webhook (Optional but Recommended)

1. Go to [Tailscale Admin Console](https://login.tailscale.com/admin/settings/webhooks)
2. Navigate to **Settings → Webhooks**
3. Click **Add Webhook**
4. Set webhook URL: `https://your-worker-name.your-subdomain.workers.dev/webhook`
5. Select events:
   - `nodeAdded`
   - `nodeDeleted`
   - `nodeUpdated`
6. Copy the webhook secret and set it in Cloudflare Dashboard: **Workers & Pages** → Your Worker → **Settings** → **Variables** → **Secrets** → Add `TAILSCALE_WEBHOOK_SECRET`

### 5. Deploy Worker

```bash
npm run deploy
```

After deployment, note your worker URL (e.g., `https://cloudflare-tailscale-dns.your-subdomain.workers.dev`)

### 6. Verify Cron Trigger

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **Workers & Pages → Your Worker → Triggers**
3. Verify cron schedule is active: `0 * * * *` (every hour)

## Development

### Local Development

```bash
npm run dev
```

### Test Webhook Locally

1. Start dev server: `npm run dev`
2. Use a tool like `ngrok` to expose local server: `ngrok http 8787`
3. Configure Tailscale webhook to point to your ngrok URL
4. Test webhook events

### Test Cron Locally

```bash
wrangler dev --test-scheduled
```

This exposes a `/__scheduled` endpoint. Test with:

```bash
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

### Generate Type Definitions

```bash
npm run cf-typegen
```

## Environment Variables

See [`.env.example`](.env.example) for a complete list of all environment variables with descriptions, where to obtain them, and example values.

## How It Works

1. **Webhook Handler** (`POST /webhook`):
   - Receives Tailscale webhook events
   - Validates webhook signature (if configured)
   - Processes `nodeAdded`, `nodeDeleted`, `nodeUpdated` events
   - Immediately syncs DNS records for affected machine

2. **Cron Handler** (hourly):
   - Fetches all devices from Tailscale API
   - Classifies IPs from device endpoints
   - Compares with existing Cloudflare records
   - Batch updates all changes (respects 200 record limit for free plan)

3. **DNS Sync Service**:
   - Creates/updates A records for each machine across three domains
   - Adds ownership comments to each record for tracking
   - Validates ownership via comments before deleting records
   - Uses batch API for efficient updates

## Troubleshooting

### DNS Records Not Created

1. Check worker logs in Cloudflare Dashboard
2. Verify all environment variables are set correctly
3. Ensure Tailscale API key has proper permissions
4. Check Cloudflare API token has DNS edit permissions

### Webhook Not Working

1. Verify webhook URL is correct in Tailscale settings
2. Check webhook secret matches if configured
3. Review worker logs for webhook errors
4. Test webhook endpoint manually: `curl -X POST https://your-worker.workers.dev/webhook`

### Cron Not Running

1. Verify cron trigger is configured in `wrangler.jsonc`
2. Check Cloudflare Dashboard → Workers → Triggers
3. Review cron logs in Cloudflare Dashboard

### IP Classification Issues

1. Check if device endpoints are being returned by Tailscale API
2. Verify LAN CIDR ranges if using custom ranges
3. Review worker logs for IP classification details

## License

MIT
