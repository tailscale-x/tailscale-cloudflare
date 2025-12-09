import type { ValidatedEnv } from '../utils/env'
import { performDnsSync } from '../utils/client-factory'
import { createLogger } from '../utils/logger'
import { setupWebhookWithKv } from '../services/tailscale-webhook-manager'
import { getSetting, getSettings, validateSettings } from '../utils/kv-storage'

const logger = createLogger()

/**
 * Handles scheduled cron jobs for full DNS synchronization
 * Also verifies and creates webhook if webhook URL is stored in KV
 */
export async function handleScheduled(
	event: ScheduledEvent,
	env: ValidatedEnv): Promise<void> {
	try {
		logger.info(`Cron job triggered: ${event.cron}`)

		const ownerId = env.DNS_RECORD_OWNER_ID || 'cloudflare-tailscale-dns'

		// Load settings manually since we are not in Hono context
		const rawSettings = await getSettings(env.CONFIG_KV, ownerId)
		const settings = validateSettings(rawSettings)

		// Verify and create webhook if webhook URL is stored in KV
		const webhookUrl = await getSetting(env.CONFIG_KV, ownerId, 'webhookUrl')
		if (webhookUrl) {
			try {
				logger.info(`Verifying Tailscale webhook configuration for: ${webhookUrl}`)
				await setupWebhookWithKv(settings, env.CONFIG_KV, webhookUrl, ownerId)
			} catch (webhookError) {
				// Log webhook error but don't fail the cron job
				logger.error('Webhook verification failed (continuing with DNS sync):', webhookError)
			}
		} else {
			logger.info(
				'Webhook URL not found in KV. Skipping webhook verification. Visit GET /webhook to set up the webhook URL.'
			)
		}

		// Perform full DNS sync
		await performDnsSync(
			settings.TAILSCALE_API_KEY,
			settings.TAILSCALE_TAILNET,
			settings.CLOUDFLARE_API_TOKEN,
			settings.DOMAIN_FOR_TAILSCALE_ENDPOINT,
			settings.DOMAIN_FOR_WAN_ENDPOINT,
			settings.DOMAIN_FOR_LAN_ENDPOINT,
			ownerId,
			settings.TAILSCALE_TAG_LAN_REGEX,
			settings.TAILSCALE_TAG_TAILSCALE_REGEX,
			settings.TAILSCALE_TAG_WAN_NO_PROXY_REGEX,
			settings.TAILSCALE_TAG_WAN_PROXY_REGEX,
			settings.LAN_CIDR_RANGES
		)
		logger.info('Cron job completed successfully')
	} catch (error) {
		logger.error('Cron job error:', error)
		throw error
	}
}
