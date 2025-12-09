import { z } from 'zod'

/**
 * Environment variables interface for Cloudflare Workers
 * Only contains bindings and variables required to bootstrap configuration
 */
export interface Env {
	// Runtime bindings
	CONFIG_KV: KVNamespace

	// Bootstrap configuration
	DNS_RECORD_OWNER_ID?: string

	// Keep LOG_LEVEL in Env for startup logging before settings are loaded
	LOG_LEVEL?: string
}

export const envSchema = z.object({
	CONFIG_KV: z.custom<KVNamespace>((val) => val !== undefined && val !== null, "CONFIG_KV is required"),
	DNS_RECORD_OWNER_ID: z.string().optional(),
	LOG_LEVEL: z.preprocess(
		(val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
		z
			.string()
			.optional()
			.refine(
				(val) => {
					if (!val) return true
					const upper = val.toUpperCase()
					return ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(upper)
				},
				{
					message: 'LOG_LEVEL must be one of: DEBUG, INFO, WARN, ERROR',
				}
			)
	)
})
