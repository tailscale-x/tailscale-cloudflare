/**
 * Environment variables interface for Cloudflare Workers
 */
export interface Env {
	TAILSCALE_API_KEY: string
	TAILSCALE_TAILNET: string
	CLOUDFLARE_API_TOKEN: string
	CLOUDFLARE_ZONE_ID: string
	DOMAIN_FOR_TAILSCALE_ENDPOINT: string
	DOMAIN_FOR_WAN_ENDPOINT: string
	DOMAIN_FOR_LAN_ENDPOINT: string
	LAN_CIDR_RANGES: string
	TAILSCALE_WEBHOOK_SECRET?: string
	DNS_RECORD_OWNER_ID?: string
	TAILSCALE_TAG_FILTER_REGEX: string
	TAILSCALE_TAG_PROXY_REGEX: string
}
