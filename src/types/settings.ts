import { z } from 'zod'


/**
 * Zod schema for settings validation
 */
export const settingsSchema = z.object({
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
            // Handle array input (already parsed from frontend)
            if (Array.isArray(val)) {
                return val.filter(r => typeof r === 'string' && r.trim().length > 0)
            }
            // Handle string input (comma-separated)
            if (typeof val === 'string' && val.trim() !== '') {
                return val.split(',').map(r => r.trim()).filter(r => r.length > 0)
            }
            // Return undefined for empty/missing values
            return undefined
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
    // Optional variables
    // DNS_RECORD_OWNER_ID is used to locate settings in KV, so it must stay in Env

    TAILSCALE_TAG_LAN_REGEX: z.preprocess(
        (val) => {
            if (!val || typeof val !== 'string' || val.trim() === '') {
                // Convert to string representation if needed? 
                // The original env schema returned a RegExp object.
                // We can't store RegExp in JSON KV easily.
                // So the SETTINGS should store strings, and we return the string, 
                // but maybe we should validate it's a valid regex string?
                return undefined
            }
            return val
        },
        z.string().refine((val) => {
            try {
                new RegExp(val)
                return true
            } catch {
                return false
            }
        }, "Invalid regular expression")
    ),
    TAILSCALE_TAG_TAILSCALE_REGEX: z.string().refine((val) => {
        try {
            new RegExp(val)
            return true
        } catch {
            return false
        }
    }, "Invalid regular expression"),
    TAILSCALE_TAG_WAN_NO_PROXY_REGEX: z.string().refine((val) => {
        try {
            new RegExp(val)
            return true
        } catch {
            return false
        }
    }, "Invalid regular expression"),
    TAILSCALE_TAG_WAN_PROXY_REGEX: z.string().refine((val) => {
        try {
            new RegExp(val)
            return true
        } catch {
            return false
        }
    }, "Invalid regular expression"),

    webhookUrl: z.string().optional(),
    webhookSecret: z.string().optional()
})

export type Settings = z.infer<typeof settingsSchema>

// Helper to hydrate regexes from strings
export interface ParsedSettings extends Omit<Settings, 'TAILSCALE_TAG_LAN_REGEX' | 'TAILSCALE_TAG_TAILSCALE_REGEX' | 'TAILSCALE_TAG_WAN_NO_PROXY_REGEX' | 'TAILSCALE_TAG_WAN_PROXY_REGEX' | 'LAN_CIDR_RANGES'> {
    TAILSCALE_TAG_LAN_REGEX: RegExp
    TAILSCALE_TAG_TAILSCALE_REGEX: RegExp
    TAILSCALE_TAG_WAN_NO_PROXY_REGEX: RegExp
    TAILSCALE_TAG_WAN_PROXY_REGEX: RegExp
    LAN_CIDR_RANGES: string[]
}
