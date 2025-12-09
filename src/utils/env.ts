import { z } from 'zod'
import { createLogger } from './logger'
import { ConfigurationError } from './errors'
import type { Env } from '../types/env'

const logger = createLogger()

/**
 * Zod schema for bootstrap environment variables
 */
const envSchema = z.object({
	CONFIG_KV: z.custom<KVNamespace>((val) => {
		return typeof val === 'object' && val !== null && 'get' in val && 'put' in val
	}, "CONFIG_KV binding is missing"),
	DNS_RECORD_OWNER_ID: z.string().optional(),
	LOG_LEVEL: z.string().optional()
})

export type ValidatedEnv = z.infer<typeof envSchema>

/**
 * Validates bootstrap environment variables
 */
export function validateEnv(env: Env): ValidatedEnv {
	try {
		return envSchema.parse(env)
	} catch (error) {
		if (error instanceof z.ZodError) {
			const errors = error.issues.map((issue) => {
				const path = issue.path.join('.')
				return `${path}: ${issue.message}`
			}).join('\n')
			const validationError = new ConfigurationError(`Environment validation failed:\n${errors}`)
			logger.error('Environment validation failed:', validationError)
			throw validationError
		}
		throw error
	}
}
