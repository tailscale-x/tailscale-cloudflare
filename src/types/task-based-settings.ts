import { z } from 'zod'

/**
 * Named CIDR list for IP classification
 * Name is immutable after creation, only CIDR ranges can be modified
 */
export interface NamedCIDRList {
    name: string // Immutable after creation
    description?: string
    cidrs: string[] // Multiple matching ranges will create multiple DNS records
    mode: 'single' | 'multiple' // Default to 'multiple'
    inverse: boolean // Default to false
}

/**
 * Machine selector for filtering Tailscale devices
 * Extensible design - can match on any Tailscale device field
 */
export interface MachineSelector {
    field: 'tag' | 'name' | string // Field to match against (extensible for future fields)
    pattern: string // Pattern to match - exact or regex if wrapped in /pattern/
}

/**
 * DNS record template configuration
 * Supports multiple record types with templating
 */
export interface RecordTemplate {
    recordType: 'A' | 'AAAA' | 'CNAME' | 'SRV' | 'TXT'
    name: string // Template string with variables
    value: string // Template string with variables
    ttl?: number
    proxied?: boolean // For A/AAAA/CNAME records

    // SRV-specific fields (also used for Associated SRV)
    priority?: number;
    weight?: number;
    port?: number;

    // If set, generates an associated SRV record (e.g. "_http._tcp") pointing to this record
    srvPrefix?: string;
}

/**
 * DNS record generation task
 * Defines how to generate DNS records for matching machines
 */
export interface GenerationTask {
    id: string // Unique identifier
    name: string // Human-readable name
    description?: string
    enabled: boolean
    machineSelector: MachineSelector
    recordTemplates: RecordTemplate[]
}

/**
 * Task-based settings schema
 */
export interface TaskBasedSettings {
    // Core API credentials
    TAILSCALE_API_KEY: string
    CLOUDFLARE_API_TOKEN: string
    TAILSCALE_TAILNET: string

    // Task-based configuration
    namedCIDRLists: NamedCIDRList[]
    generationTasks: GenerationTask[]

    // Optional webhook configuration
    webhookUrl?: string
    webhookSecret?: string
}

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

export const namedCIDRListSchema = z.object({
    name: z
        .string()
        .min(1, 'CIDR list name is required')
        .regex(/^[a-zA-Z0-9_-]+$/, 'CIDR list name must contain only letters, numbers, hyphens, and underscores'),
    description: z.string().optional(),
    cidrs: z
        .array(z.string())
        .min(1, 'At least one CIDR range is required')
        .refine(
            (ranges) => {
                // CIDR format: x.x.x.x/y where x is 0-255 and y is 0-32
                const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/
                return ranges.every((range) => {
                    if (!cidrRegex.test(range)) return false
                    const parts = range.split('/')
                    const ip = parts[0]
                    const mask = parts[1]
                    if (!ip || mask === undefined) return false
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
                message: 'All CIDR ranges must be valid (e.g., "192.168.1.0/24")',
            }
        ),
    mode: z.enum(['single', 'multiple']).default('multiple'),
    inverse: z.boolean().default(false),
})

export const machineSelectorSchema = z.object({
    field: z.string().min(1, 'Selector field is required'),
    pattern: z.string().min(1, 'Selector pattern is required').refine(
        (pattern) => {
            // If pattern is wrapped in /, validate regex syntax
            if (pattern.startsWith('/') && pattern.endsWith('/')) {
                const regexPattern = pattern.slice(1, -1)
                try {
                    new RegExp(regexPattern)
                    return true
                } catch {
                    return false
                }
            }
            // Exact match patterns are always valid
            return true
        },
        {
            message: 'Invalid regex pattern syntax',
        }
    ),
})

export const recordTemplateSchema = z.object({
    recordType: z.enum(['A', 'AAAA', 'CNAME', 'SRV', 'TXT']),
    name: z.string().min(1, 'Record name template is required'),
    value: z.string().min(1, 'Record value template is required'),
    ttl: z.number().int().positive().optional(),
    proxied: z.boolean().optional(),

    // SRV-specific fields (also used for Associated SRV)
    priority: z.number().int().min(0).default(10),
    weight: z.number().int().min(0).default(10),
    port: z.number().int().min(1).max(65535).default(80),

    // Associated SRV prefix
    srvPrefix: z.string().optional(),
}).refine(
    (data) => {
        // If recordType is SRV, require priority, weight, and port fields
        if (data.recordType === 'SRV') {
            return data.priority !== undefined && data.weight !== undefined && data.port !== undefined
        }

        // If associated SRV is used (srvPrefix set), we generally want valid port/pri/weight 
        // but they have defaults in the schema above so they are always present.

        return true
    },
    {
        message: 'SRV records require priority/weight/port',
    }
)

export const generationTaskSchema = z.object({
    id: z.string().min(1, 'Task ID is required'),
    name: z.string().min(1, 'Task name is required'),
    description: z.string().optional(),
    enabled: z.boolean(),
    machineSelector: machineSelectorSchema,
    recordTemplates: z.array(recordTemplateSchema).min(1, 'At least one record template is required'),
})

export const taskBasedSettingsSchema = z.object({
    // Core API credentials
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
    TAILSCALE_TAILNET: z.string().min(1, 'TAILSCALE_TAILNET is required'),

    // Task-based configuration
    namedCIDRLists: z
        .array(namedCIDRListSchema)
        .refine(
            (lists) => {
                // Ensure CIDR list names are unique
                const names = lists.map((list) => list.name)
                return names.length === new Set(names).size
            },
            {
                message: 'CIDR list names must be unique',
            }
        ),
    generationTasks: z
        .array(generationTaskSchema)
        .refine(
            (tasks) => {
                // Ensure task IDs are unique
                const ids = tasks.map((task) => task.id)
                return ids.length === new Set(ids).size
            },
            {
                message: 'Task IDs must be unique',
            }
        ),

    // Optional webhook configuration
    webhookUrl: z.string().optional(),
    webhookSecret: z.string().optional(),
})

export type TaskBasedSettingsInput = z.infer<typeof taskBasedSettingsSchema>
