import type { Context } from 'hono'
import type { TailscaleWebhookEvent } from '../types/tailscale'
import type { AppContext } from '../types/app'
import { validateWebhookSignature } from '../utils/webhook'
import { performDnsSync } from '../utils/client-factory'
import { createLogger } from '../utils/logger'
import { setupWebhookWithKv } from '../services/tailscale-webhook-manager'
import {
	setSetting,
	getSetting,
} from '../utils/kv-storage'
import { extractWebhookUrlFromRequest } from '../utils/webhook'

const logger = createLogger()

/**
 * Handles GET /webhook - Manual sync and webhook setup
 */
async function handleGetWebhook(c: Context<AppContext>): Promise<Response> {
	try {
		const env = c.env
		const settings = c.get('settings')
		const ownerId = env.DNS_RECORD_OWNER_ID || 'cloudflare-tailscale-dns'

		// Extract webhook URL from request
		const webhookUrl = extractWebhookUrlFromRequest(c.req.raw)
		logger.info(`GET /webhook - Webhook URL: ${webhookUrl}`)

		// Store webhook URL in KV
		await setSetting(env.CONFIG_KV, ownerId, 'webhookUrl', webhookUrl)

		// Setup webhook if Tailscale API is available
		let webhookResult = null
		try {
			logger.info('Setting up Tailscale webhook...')
			const setupResult = await setupWebhookWithKv(settings, env.CONFIG_KV, webhookUrl, ownerId)
			webhookResult = setupResult.result
		} catch (webhookError) {
			logger.error('Webhook setup failed (continuing with sync):', webhookError)
		}

		// Perform full DNS sync
		const result = await performDnsSync(
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

		logger.info('GET /webhook - Full DNS synchronization completed successfully')
		return c.json({
			success: true,
			message: 'Full DNS synchronization completed successfully',
			webhook: webhookResult
				? {
					setup: true,
					message: webhookResult.message,
					created: webhookResult.created,
					updated: webhookResult.updated,
					secretProvided: !!webhookResult.secret,
				}
				: { setup: false, message: 'Webhook setup skipped due to error' },
			sync: {
				added: result.added,
				deleted: result.deleted,
				summary: result.summary,
			},
		})
	} catch (error) {
		logger.error('GET /webhook error:', error)
		return c.json(
			{
				error: 'Internal server error',
				message: error instanceof Error ? error.message : String(error),
			},
			500
		)
	}
}

/**
 * Handles POST /webhook - Tailscale webhook events
 */
async function handlePostWebhook(c: Context<AppContext>): Promise<Response> {
	try {
		const env = c.env
		const settings = c.get('settings')
		const ownerId = env.DNS_RECORD_OWNER_ID || 'cloudflare-tailscale-dns'
		const body = await c.req.text()
		const signature = c.req.header('X-Tailscale-Signature') || null

		// Validate webhook signature if secret is stored in KV
		const webhookSecret = await getSetting(env.CONFIG_KV, ownerId, 'webhookSecret')
		if (webhookSecret) {
			const isValid = await validateWebhookSignature(body, signature, webhookSecret)
			if (!isValid) {
				return c.json({ error: 'Invalid webhook signature' }, 401)
			}
		} else {
			logger.warn('Webhook secret not found in KV, skipping signature validation')
		}

		// Parse webhook event
		const event: TailscaleWebhookEvent = JSON.parse(body)

		// Always sync all machines regardless of event type
		const result = await performDnsSync(
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
		logger.info(`Webhook processed successfully: ${event.event}`)
		return c.json({
			success: true,
			event: event.event,
			added: result.added,
			deleted: result.deleted,
			summary: result.summary,
		})
	} catch (error) {
		logger.error('POST /webhook error:', error)
		return c.json(
			{
				error: 'Internal server error',
				message: error instanceof Error ? error.message : String(error),
			},
			500
		)
	}
}

/**
 * Handles webhook endpoint - GET for sync-all + webhook setup, POST for Tailscale events
 */
export async function handleWebhook(c: Context<AppContext>): Promise<Response> {
	if (c.req.method === 'GET') {
		return handleGetWebhook(c)
	} else if (c.req.method === 'POST') {
		return handlePostWebhook(c)
	} else {
		return c.json({ error: 'Method not allowed' }, 405)
	}
}
