import type { Context, Next } from 'hono'
import type { Env } from '../types/env'
import type { ValidatedEnv } from '../utils/env'
import { validateEnv } from '../utils/env'
import { createLogger } from '../utils/logger'

const logger = createLogger()

/**
 * Variables type added by envValidationMiddleware
 * This can be composed with other middleware Variables types
 */
export type EnvValidationVariables = {
	validatedEnv: ValidatedEnv
}

/**
 * Middleware to validate and inject environment variables into context
 * Validates env on every request and makes validatedEnv available via c.get('validatedEnv')
 * 
 * This middleware accepts a context that has at least EnvValidationVariables,
 * but can also have additional Variables from other middlewares
 */
export async function envValidationMiddleware<
	T extends {
		Bindings: Env
		Variables?: Record<string, unknown>
	}
>(
	c: Context<T & { Variables: T['Variables'] & EnvValidationVariables }>,
	next: Next
) {
	try {
		const validatedEnv = validateEnv(c.env)
		c.set('validatedEnv', validatedEnv)
		await next()
	} catch (error) {
		logger.error('Environment validation failed:', error)
		return c.json(
			{
				error: 'Configuration error',
				message: error instanceof Error ? error.message : String(error),
			},
			500
		)
	}
}
