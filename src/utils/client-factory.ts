import type { ValidatedEnv } from './env'
import { TailscaleClient } from '../services/tailscale'
import { CloudflareClient } from '../services/cloudflare'
import { TailscaleMachineSyncService } from '../services/tailscale-machine-sync'
import { createLogger } from './logger'

const logger = createLogger()

/**
 * Creates and configures all necessary clients for DNS synchronization
 */
export function createTailscaleMachineSyncService(env: ValidatedEnv): TailscaleMachineSyncService {
	const lanCidrRanges = env.LAN_CIDR_RANGES

	const tailscaleClient = new TailscaleClient({
		apiKey: env.TAILSCALE_API_KEY,
		tailnet: env.TAILSCALE_TAILNET,
		lanCidrRanges,
	})

	const cloudflareClient = new CloudflareClient({
		apiToken: env.CLOUDFLARE_API_TOKEN,
		zoneId: env.CLOUDFLARE_ZONE_ID,
	})

	const ownerId = env.DNS_RECORD_OWNER_ID || 'cloudflare-tailscale-dns'

	logger.info(`Creating DNS sync service with owner ID: ${ownerId}`)
	logger.info(`Tag filter regex: ${env.TAILSCALE_TAG_FILTER_REGEX.source}`)
	logger.info(`Proxy tag regex: ${env.TAILSCALE_TAG_PROXY_REGEX.source}`)

	return new TailscaleMachineSyncService({
		tailscaleClient,
		cloudflareClient,
		tsDomain: env.DOMAIN_FOR_TAILSCALE_ENDPOINT,
		wanDomain: env.DOMAIN_FOR_WAN_ENDPOINT,
		lanDomain: env.DOMAIN_FOR_LAN_ENDPOINT,
		ownerId,
		tagFilterRegex: env.TAILSCALE_TAG_FILTER_REGEX,
		proxyTagRegex: env.TAILSCALE_TAG_PROXY_REGEX,
		lanCidrRanges,
	})
}
