// Shared credentials used by task-based configurations
// These are stored separately and merged when needed

import { z } from 'zod'

/**
 * Shared API credentials and webhook configuration
 * Used by TaskBasedSettings
 */
export interface SharedCredentials {
    // Tailscale API credentials
    TAILSCALE_API_KEY: string
    TAILSCALE_TAILNET: string

    // Cloudflare API credentials
    CLOUDFLARE_API_TOKEN: string
}

/**
 * Zod schema for validating shared credentials
 */
export const SharedCredentialsSchema = z.object({
    TAILSCALE_API_KEY: z.string().min(1, 'Tailscale API key is required'),
    TAILSCALE_TAILNET: z.string().min(1, 'Tailscale tailnet is required'),
    CLOUDFLARE_API_TOKEN: z.string().min(1, 'Cloudflare API token is required'),
})

/**
 * Sensitive fields that should be masked when sending to client
 */
export const SHARED_CREDENTIALS_SENSITIVE_KEYS: (keyof SharedCredentials)[] = [
    'TAILSCALE_API_KEY',
    'CLOUDFLARE_API_TOKEN',
]

/**
 * Extract shared credentials from legacy Settings
 */
export function extractSharedCredentials(settings: any): SharedCredentials {
    return {
        TAILSCALE_API_KEY: settings.TAILSCALE_API_KEY || '',
        TAILSCALE_TAILNET: settings.TAILSCALE_TAILNET || '',
        CLOUDFLARE_API_TOKEN: settings.CLOUDFLARE_API_TOKEN || '',
    }
}

/**
 * Merge shared credentials into task-based settings
 */
export function mergeCredentialsIntoTaskBased(taskSettings: any, credentials: SharedCredentials): any {
    return {
        ...taskSettings,
        TAILSCALE_API_KEY: credentials.TAILSCALE_API_KEY,
        TAILSCALE_TAILNET: credentials.TAILSCALE_TAILNET,
        CLOUDFLARE_API_TOKEN: credentials.CLOUDFLARE_API_TOKEN,
    }
}

