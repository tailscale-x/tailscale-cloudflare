import { Hono } from 'hono'
import type { Env } from './types/env'
import type { AppContext } from './types/app'
import { settingsMiddleware } from './middleware/settings'
import { errorHandler } from './middleware/error-handler'
import { handleWebhook } from './handlers/webhook'
import { handleScheduled } from './handlers/scheduled'
import { configHandler } from './handlers/config'
import { createLogger } from './utils/logger'
import { validateEnv } from './utils/env'

const logger = createLogger()

const app = new Hono<AppContext>()

// Global error handler - must be registered before other middleware
app.onError(errorHandler)

// Middleware to validate and inject settings into context
app.use('*', settingsMiddleware)

// Health check endpoint
app.get('/', (c) => {
	logger.info('Health check endpoint accessed')
	return c.json({ status: 'ok', service: 'tailscale-cloudflare-dns-sync' })
})

// Webhook endpoint: GET for sync-all + webhook setup, POST for Tailscale events
app.all('/webhook', handleWebhook)

// Config UI endpoint
app.all('/config', configHandler)

// Worker entry point
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Validation and error handling happens in middleware
		return app.fetch(request, env, ctx)
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		try {
			const validatedEnv = validateEnv(env)
			await handleScheduled(event, validatedEnv, ctx)
		} catch (error) {
			logger.error('Scheduled handler error:', error)
			throw error
		}
	},
}
