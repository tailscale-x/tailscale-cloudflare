# tailscale-cloudflare

A Cloudflare Worker that automatically syncs DNS records from Tailscale machines to Cloudflare DNS. Each machine creates A records across three configurable domains (Tailscale, WAN, and LAN) with ownership validation using DNS record comments.

## Features

| Feature | Description |
|---------|-------------|
| **Webhook Integration** | Real-time DNS updates when machines are added, updated, or deleted in Tailscale |
| **Cron Sync** | Hourly full synchronization to ensure perfect sync |
| **IP Classification** | Automatically classifies IPs as LAN (private) or WAN (public) based on CIDR ranges |
| **Tag Filtering** | Filter devices by Tailscale tags using regex patterns (optional) |
| **Cloudflare Proxy** | Enable Cloudflare proxy (orange cloud) for devices based on tag regex patterns (optional) |
| **Ownership Validation** | Uses DNS record comments to track ownership and prevent conflicts |
| **Batch Operations** | Efficient batch API usage for Cloudflare free plan (200 records per batch) |

## How It Works

```mermaid
sequenceDiagram
    participant WH as Webhook/Cron/syncAll
    participant SYNC as DNS Sync Service
    participant TS as Tailscale Client
    participant CF as Cloudflare Client
    participant DNS as Cloudflare DNS
    
    WH->>SYNC: syncAllMachines()
    SYNC->>TS: getDevices()
    TS-->>SYNC: Device List
    SYNC->>TS: classifyEndpoints(device)
    TS-->>SYNC: Classified IPs (TS/LAN/WAN)
    SYNC->>SYNC: Build Expected Records
    SYNC->>CF: getExistingRecordsByComment()
    CF->>DNS: Query by comment prefix
    DNS-->>CF: Existing Records
    CF-->>SYNC: Existing Records
    SYNC->>SYNC: Perform Diff
    SYNC->>CF: batchDeleteAndCreate()
    CF->>DNS: Batch Update (200/batch)
    DNS-->>CF: Success
    CF-->>SYNC: Complete
    SYNC-->>WH: Sync Result
```

### Component Details

| Component | Description |
|-----------|-------------|
| **Webhook Handler** (`GET /webhook`) | Manual endpoint to trigger full synchronization and set up Tailscale webhook. Extracts webhook URL from request and stores it in KV |
| **Webhook Handler** (`POST /webhook`) | Receives Tailscale webhook events, validates signatures, and triggers full sync of all machines |
| **Cron Handler** (hourly) | Scheduled job that performs full synchronization of all devices from Tailscale to Cloudflare DNS. Also verifies and updates webhook configuration using URL stored in KV |
| **DNS Sync Service** | Orchestrates the sync process: fetches devices, classifies IPs, builds expected records, fetches existing records, performs diff, and executes batch operations |
| **Tailscale Client** | Handles Tailscale API interactions and IP classification (LAN/WAN/TS) based on configured CIDR ranges |
| **Cloudflare Client** | Manages Cloudflare DNS API operations including fetching records by comment prefix and batch create/delete operations |

### DNS Record Structure

For each machine `<machine-name>`, the following DNS records are created:

| Record Type | Domain Pattern | IP Type | Description |
|-------------|----------------|---------|-------------|
| A | `<machine-name>.<ts-domain>` | Tailscale IP | Tailscale-assigned IP address (typically 100.x.y.z) |
| A | `<machine-name>.<wan-domain>` | WAN IP | Public IP address (before router NAT). Used for dyndns-style CNAME records. Typically points to a reverse proxy which routes to backend services |
| A | `<machine-name>.<lan-domain>` | LAN IP | Private IP address (private IP ranges, matches LAN_CIDR_RANGES) |

Each A record includes an ownership comment for tracking and validation.

### Ownership Comment Format

DNS records use Cloudflare's comment field for ownership tracking:

| Property | Value |
|----------|-------|
| **Format** | `cf-ts-dns:<owner-id>:<machine-name>` |
| **Example** | `cf-ts-dns:cloudflare-tailscale-dns:my-machine` |
| **Purpose** | Identifies which records are managed by this service and prevents conflicts |
| **Limitation** | Comments are truncated to 100 characters to comply with Cloudflare's API limits |

### IP Classification

The worker extracts IP addresses from Tailscale device endpoints. Only **LAN IPs** are classified based on CIDR ranges configured via the `LAN_CIDR_RANGES` environment variable (required, no defaults).

**Note**: 
- **WAN IPs** are any IPs that are not classified as LAN (no explicit classification needed). These are public IP addresses (before router NAT) and are typically used for dyndns-style CNAME records pointing to reverse proxies rather than direct service connections
- **Tailscale IPs** are returned directly from the Tailscale API and do not require classification

### WAN IP Explanation

**WAN IP** stands for "Wide Area Network IP" and refers to the public IP address assigned to your network by your ISP, before router NAT (Network Address Translation). 

**Key characteristics:**
- **Public IP**: Reachable from the internet
- **Before NAT**: The IP your router receives from your ISP, not the private IP behind NAT
- **Dynamic**: May change if your ISP uses dynamic IP assignment
- **Use case**: Ideal for dyndns-style CNAME records that automatically update when your public IP changes

**Typical usage pattern:**
1. WAN domain records (e.g., `server1.wan.example.com`) point to the public IP
2. Custom domains create CNAME records pointing to WAN domain records
3. Traffic flows: Client → Custom Domain (CNAME) → WAN Domain (A Record) → Public IP → Reverse Proxy → Backend Services via Tailscale

This eliminates the need for separate dynamic DNS software, as the cloudflare-tailscale-dns service automatically updates WAN domain records when Tailscale detects IP changes.

**Important**: The `LAN_CIDR_RANGES` configuration is ordered. When a device has multiple endpoints that match different CIDR ranges, the endpoint matching the **first range** in the ordered list is chosen as the LAN IP. This allows you to prioritize specific ranges by placing them earlier in the comma-separated list.


## Prerequisites

| Requirement | Description |
|-------------|-------------|
| **Tailscale Account** | Account with API access enabled |
| **Cloudflare Account** | Account with DNS zone configured |
| **Cloudflare API Token** | API token with DNS edit permissions |

## Setup Instructions

### 1. Development Container Setup

This project includes a devcontainer configuration for a consistent development environment.

**Using VS Code:**
1. Open the project in VS Code
2. When prompted, click "Reopen in Container" or use Command Palette: `Dev Containers: Reopen in Container`
3. Dependencies will be automatically installed via the `postStartCommand`

**Using Docker directly:**
```bash
# Build the devcontainer
docker build -f .devcontainer/Dockerfile -t cloudflare-worker-dns .

# Run the container
docker run -it --rm -v $(pwd):/workspace cloudflare-worker-dns
```

The devcontainer automatically runs `npm install && npm run cf-typegen` on startup.

### 2. Configure Cloudflare KV Namespace

The worker uses Cloudflare KV to store all configuration settings. You need to create a KV namespace and bind it to your worker.

**Option 1: Using Wrangler CLI (Recommended for Development)**

1. Create a KV namespace:
   ```bash
   wrangler kv:namespace create "CONFIG_KV"
   ```

2. Copy the namespace ID from the output and add it to `wrangler.jsonc`:
   ```jsonc
   "kv_namespaces": [
     {
       "binding": "CONFIG_KV",
       "id": "your-namespace-id-here"
     }
   ]
   ```

**Option 2: Using Cloudflare Dashboard**

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **Workers & Pages** → **KV**
3. Click **Create a namespace**
4. Name it (e.g., `tailscale-config-kv`) and create it
5. Go to **Workers & Pages** → Your Worker → **Settings** → **Variables**
6. Scroll to **KV Namespace Bindings** and click **Add binding**
7. Set **Variable name** to `CONFIG_KV` and select your namespace

### 3. Deploy Worker

```bash
npm run deploy
```

After deployment, note your worker URL (e.g., `https://cloudflare-tailscale-dns.your-subdomain.workers.dev`)

### 4. Configure Settings via Web UI

After deployment, navigate to `https://your-worker-name.your-subdomain.workers.dev/config` to configure all settings through the web interface. The configuration page includes detailed instructions and validation for each setting.

**Optional Environment Variable:**

You can optionally set `DNS_RECORD_OWNER_ID` as an environment variable in the Cloudflare Dashboard if you need multiple instances managing the same DNS zone:

1. Go to **Workers & Pages** → Your Worker → **Settings** → **Variables**
2. Add `DNS_RECORD_OWNER_ID` with a unique identifier (default: `cloudflare-tailscale-dns`)


### 5. Configure Tailscale Webhook (Optional but Recommended)

**Automated Setup (Recommended):**

The worker can automatically create and manage Tailscale webhooks. The webhook URL is automatically detected from requests and stored in KV.

1. **Deploy Worker**: Deploy your worker first (see step 3 above)

2. **Configure Settings**: Configure your settings via the `/config` UI (see step 4 above)

3. **Trigger Webhook Setup**: Visit `GET /webhook` endpoint:
   ```bash
   curl https://your-worker-name.your-subdomain.workers.dev/webhook
   ```
   
   This will:
   - Extract the webhook URL from the request
   - Store it in Cloudflare KV
   - Create/update the Tailscale webhook automatically
   - Perform a full DNS sync
   - Return the webhook setup status and sync results

4. **Automatic Secret Storage**: The webhook secret is automatically stored in Cloudflare KV when the webhook is created. No manual configuration needed!

5. **Cron Job Verification**: The hourly cron job will automatically verify and update the webhook configuration using the stored URL and secret from KV.

**Note**: The automated setup requires your Tailscale API key to have `webhooks` OAuth scope. Most API keys with device read permissions also have webhook permissions. If webhook creation fails, check your API key permissions in the Tailscale Admin Console.

### 6. Deploy Worker

```bash
npm run deploy
```

After deployment, note your worker URL (e.g., `https://cloudflare-tailscale-dns.your-subdomain.workers.dev`)

**Important**: After deployment, configure settings via `/config` and visit `GET /webhook` to set up the webhook URL and trigger the first sync (see steps 4-5 above).

### 7. Verify Cron Trigger

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

## License

MIT
