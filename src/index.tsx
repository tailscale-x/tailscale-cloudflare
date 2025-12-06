import { Hono } from 'hono'
import type { Env } from './types/env'
import type { AppContext } from './types/app'
import { validateEnv } from './utils/env'
import { envValidationMiddleware } from './middleware/env-validation'
import { errorHandler } from './middleware/error-handler'
import { handleWebhook } from './handlers/webhook'
import { handleScheduled } from './handlers/scheduled'
import { handleSyncAll } from './handlers/sync-all'
import { createLogger } from './utils/logger'

const logger = createLogger()

const app = new Hono<AppContext>()

// Global error handler - must be registered before other middleware
app.onError(errorHandler)

// Middleware to validate and inject env into context
app.use('*', envValidationMiddleware)

// Health check endpoint
app.get('/', (c) => {
	logger.info('Health check endpoint accessed')
	return c.json({ status: 'ok', service: 'tailscale-cloudflare-dns-sync' })
})

// Webhook endpoint for Tailscale events
app.post('/webhook', handleWebhook)

// Manual sync endpoint
app.get('/syncAll', handleSyncAll)

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
