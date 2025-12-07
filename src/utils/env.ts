import { z } from 'zod'
import { createLogger } from './logger'
import { ConfigurationError } from './errors'

const logger = createLogger()

/**
 * Zod schema for environment variable validation
 */
const envSchema = z.object({
	// Required secrets
	TAILSCALE_API_KEY: z
		.string()
		.min(1, 'TAILSCALE_API_KEY is required')
		.regex(
			/^tskey-api-[a-zA-Z0-9_-]+$/,
			'TAILSCALE_API_KEY must start with "tskey-api-" followed by alphanumeric characters, hyphens, or underscores'
		),
	CLOUDFLARE_API_TOKEN: z
		.string()
		.min(1, 'CLOUDFLARE_API_TOKEN is required')
		.regex(
			/^[a-zA-Z0-9_-]+$/,
			'CLOUDFLARE_API_TOKEN must be alphanumeric and may contain hyphens or underscores'
		)
		.min(40, 'CLOUDFLARE_API_TOKEN appears to be too short (minimum 40 characters)'),

	// Required variables
	TAILSCALE_TAILNET: z.string().min(1, 'TAILSCALE_TAILNET is required'),
	CLOUDFLARE_ZONE_ID: z.string().min(1, 'CLOUDFLARE_ZONE_ID is required'),
	// Domain configurations are optional - if empty, DNS records for that domain type will not be created
	DOMAIN_FOR_TAILSCALE_ENDPOINT: z.preprocess(
		(val) => (typeof val === 'string' ? val.trim() : ''),
		z.string()
	),
	DOMAIN_FOR_WAN_ENDPOINT: z.preprocess(
		(val) => (typeof val === 'string' ? val.trim() : ''),
		z.string()
	),
	DOMAIN_FOR_LAN_ENDPOINT: z.preprocess(
		(val) => (typeof val === 'string' ? val.trim() : ''),
		z.string()
	),
	LAN_CIDR_RANGES: z.preprocess(
		(val) => {
			if (!val || typeof val !== 'string' || val.trim() === '') {
				throw new z.ZodError([
					{
						code: z.ZodIssueCode.custom,
						path: ['LAN_CIDR_RANGES'],
						message: 'LAN_CIDR_RANGES is required',
					},
				])
			}
			return val.split(',').map(r => r.trim()).filter(r => r.length > 0)
		},
		z
			.array(z.string())
			.min(1, 'LAN_CIDR_RANGES must contain at least one CIDR range')
			.refine(
				(ranges) => {
					// CIDR format: x.x.x.x/y where x is 0-255 and y is 0-32
					const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/
					return ranges.every((range) => {
						if (!cidrRegex.test(range)) return false
						const [ip, mask] = range.split('/')
						const octets = ip.split('.').map(Number)
						const subnetMask = Number(mask)
						return (
							octets.length === 4 &&
							octets.every((octet) => octet >= 0 && octet <= 255) &&
							subnetMask >= 0 &&
							subnetMask <= 32
						)
					})
				},
				{
					message: 'LAN_CIDR_RANGES must be a comma-separated list of valid CIDR ranges (e.g., "10.0.0.0/8,192.168.0.0/16")',
				}
			)
	),

	// Optional variables
	TAILSCALE_WEBHOOK_SECRET: z.preprocess(
		(val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
		z.string().optional()
	),
	DNS_RECORD_OWNER_ID: z.preprocess(
		(val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
		z.string().optional()
	),
	TAILSCALE_TAG_FILTER_REGEX: z.preprocess(
		(val) => {
			if (!val || typeof val !== 'string' || val.trim() === '') {
				throw new z.ZodError([
					{
						code: z.ZodIssueCode.custom,
						path: ['TAILSCALE_TAG_FILTER_REGEX'],
						message: 'TAILSCALE_TAG_FILTER_REGEX is required',
					},
				])
			}
			try {
				return new RegExp(val)
			} catch (error) {
				throw new z.ZodError([
					{
						code: z.ZodIssueCode.custom,
						path: ['TAILSCALE_TAG_FILTER_REGEX'],
						message: `Invalid regular expression: ${val}`,
					},
				])
			}
		},
		z.instanceof(RegExp)
	),
	TAILSCALE_TAG_PROXY_REGEX: z.preprocess(
		(val) => {
			if (!val || typeof val !== 'string' || val.trim() === '') {
				throw new z.ZodError([
					{
						code: z.ZodIssueCode.custom,
						path: ['TAILSCALE_TAG_PROXY_REGEX'],
						message: 'TAILSCALE_TAG_PROXY_REGEX is required',
					},
				])
			}
			try {
				return new RegExp(val)
			} catch (error) {
				throw new z.ZodError([
					{
						code: z.ZodIssueCode.custom,
						path: ['TAILSCALE_TAG_PROXY_REGEX'],
						message: `Invalid regular expression: ${val}`,
					},
				])
			}
		},
		z.instanceof(RegExp)
	),
	CONFIG_SSE_INTERVAL_MS: z.preprocess(
		(val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
		z.string().optional()
	),
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
	),
})

export type ValidatedEnv = z.infer<typeof envSchema>

/**
 * Validates environment variables using Zod schema
 * Throws an error with detailed validation messages if validation fails
 */
export function validateEnv(env: unknown): ValidatedEnv {
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
		logger.error('Environment validation error:', error)
		if (error instanceof ConfigurationError) {
			throw error
		}
		throw new ConfigurationError(`Environment validation error: ${error instanceof Error ? error.message : String(error)}`)
	}
}
