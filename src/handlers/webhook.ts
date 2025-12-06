import type { Context } from 'hono'
import type { TailscaleWebhookEvent } from '../types/tailscale'
import type { AppContext } from '../types/app'
import { validateWebhookSignature } from '../utils/validation'
import { createTailscaleMachineSyncService } from '../utils/client-factory'
import { createLogger } from '../utils/logger'

const logger = createLogger()

/**
 * Handles Tailscale webhook events
 */
export async function handleWebhook(
	c: Context<AppContext>
): Promise<Response> {
	try {
		const env = c.get('validatedEnv')
		const body = await c.req.text()
		const signature = c.req.header('X-Tailscale-Signature') || null

		// Validate webhook signature if secret is configured
		if (env.TAILSCALE_WEBHOOK_SECRET) {
			const isValid = await validateWebhookSignature(
				body,
				signature,
				env.TAILSCALE_WEBHOOK_SECRET
			)
			if (!isValid) {
				return c.json({ error: 'Invalid webhook signature' }, 401)
			}
		}

		// Parse webhook event
		const event: TailscaleWebhookEvent = JSON.parse(body)

		// Initialize DNS sync service
		const tailscaleMachineSync = createTailscaleMachineSyncService(env)

		// Always sync all machines regardless of event type
		const result = await tailscaleMachineSync.syncAllMachines()
		logger.info(`Webhook processed successfully: ${event.event}`)
		return c.json({ 
			success: true, 
			event: event.event,
			added: result.added,
			deleted: result.deleted,
			summary: result.summary,
		})
	} catch (error) {
		logger.error('Webhook error:', error)
		return c.json(
			{
				error: 'Internal server error',
				message: error instanceof Error ? error.message : String(error),
			},
			500
		)
	}
}
