// Machine Selector for filtering Tailscale devices
// Extensible design supporting tag, name, and future device fields

import type { TailscaleDevice } from '../types/tailscale'
import type { MachineSelector } from '../types/task-based-settings'

/**
 * Result of machine selection with capture groups
 */
export interface SelectionResult {
    matched: boolean
    captures: Record<string, string> // Numbered ($1, $2) and named capture groups
}

/**
 * Extract value from Tailscale device based on field name
 * Extensible for future device fields
 */
function getDeviceFieldValue(device: TailscaleDevice, field: string): string[] {
    switch (field) {
        case 'tag':
            return device.tags || []
        case 'name':
            // Extract machine name (first part of hostname)
            const machineName = device.name?.split('.').shift()
            return machineName ? [machineName] : []
        case 'hostname':
            return device.hostname ? [device.hostname] : []
        // Future extensibility: can add more fields like 'os', 'user', 'ipAddress', etc.
        default:
            // Try to access field directly from device object (for future fields)
            const value = (device as any)[field]
            if (typeof value === 'string') {
                return [value]
            } else if (Array.isArray(value)) {
                return value.filter((v) => typeof v === 'string')
            }
            return []
    }
}

/**
 * Check if pattern is a regex (wrapped in /.../)
 */
function isRegexPattern(pattern: string): boolean {
    return pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2
}

/**
 * Extract regex pattern from /pattern/ format
 */
function extractRegexPattern(pattern: string): string {
    return pattern.slice(1, -1)
}

/**
 * Extract capture groups from regex match
 * Supports both numbered ($1, $2) and named ((?<name>...)) captures
 */
function extractCaptures(match: RegExpMatchArray | null): Record<string, string> {
    if (!match) {
        return {}
    }

    const captures: Record<string, string> = {}

    // Add numbered captures ($1, $2, etc.)
    for (let i = 1; i < match.length; i++) {
        if (match[i] !== undefined) {
            captures[String(i)] = match[i]
        }
    }

    // Add named captures
    if (match.groups) {
        Object.assign(captures, match.groups)
    }

    return captures
}

/**
 * Match a single value against a selector
 */
function matchValue(value: string, selector: MachineSelector): SelectionResult {
    const { pattern } = selector

    // Regex matching
    if (isRegexPattern(pattern)) {
        try {
            const regexPattern = extractRegexPattern(pattern)
            const regex = new RegExp(regexPattern)
            const match = value.match(regex)

            if (match) {
                return {
                    matched: true,
                    captures: extractCaptures(match),
                }
            }
        } catch (error) {
            // Invalid regex - treat as non-match
            console.error(`Invalid regex pattern: ${pattern}`, error)
            return { matched: false, captures: {} }
        }
    }

    // Exact matching
    const matched = value === pattern
    return { matched, captures: {} }
}

/**
 * Select devices matching the given selector
 * Returns matched devices with their capture groups
 */
export function selectMachines(
    devices: TailscaleDevice[],
    selector: MachineSelector
): Array<{ device: TailscaleDevice; captures: Record<string, string> }> {
    const results: Array<{ device: TailscaleDevice; captures: Record<string, string> }> = []

    for (const device of devices) {
        const fieldValues = getDeviceFieldValue(device, selector.field)

        // Try to match any of the field values
        for (const value of fieldValues) {
            const result = matchValue(value, selector)
            if (result.matched) {
                results.push({
                    device,
                    captures: result.captures,
                })
                break // Only match once per device
            }
        }
    }

    return results
}

/**
 * Test if a selector matches a specific device
 * Useful for testing and validation
 */
export function testSelector(device: TailscaleDevice, selector: MachineSelector): SelectionResult {
    const fieldValues = getDeviceFieldValue(device, selector.field)

    for (const value of fieldValues) {
        const result = matchValue(value, selector)
        if (result.matched) {
            return result
        }
    }

    return { matched: false, captures: {} }
}

/**
 * Validate selector syntax
 */
export function validateSelector(selector: MachineSelector): { valid: boolean; error?: string } {
    const { field, pattern } = selector

    if (!field || field.trim() === '') {
        return { valid: false, error: 'Selector field cannot be empty' }
    }

    if (!pattern || pattern.trim() === '') {
        return { valid: false, error: 'Selector pattern cannot be empty' }
    }

    // If pattern is regex, validate regex syntax
    if (isRegexPattern(pattern)) {
        try {
            const regexPattern = extractRegexPattern(pattern)
            new RegExp(regexPattern)
        } catch (error) {
            return {
                valid: false,
                error: `Invalid regex syntax: ${error instanceof Error ? error.message : String(error)}`,
            }
        }
    }

    return { valid: true }
}

/**
 * Get supported field types
 * Can be extended in the future
 */
export type FieldType = 'text' | 'autocomplete'

export interface SupportedField {
    value: string
    label: string
    description: string
    type: FieldType
    getUniqueValues?: (devices: TailscaleDevice[]) => string[]
}

/**
 * Get supported field types
 * Can be extended in the future
 */
export function getSupportedFields(): SupportedField[] {
    return [
        {
            value: 'tag',
            label: 'Tag',
            description: 'Match against Tailscale tags (e.g., "tag:lan", "tag:web")',
            type: 'autocomplete',
            getUniqueValues: (devices) => {
                const tags = new Set<string>()
                devices.forEach((d) => d.tags?.forEach((t) => tags.add(t)))
                return Array.from(tags).sort()
            },
        },
        {
            value: 'name',
            label: 'Machine Name',
            description: 'Match against machine name (first part of hostname)',
            type: 'autocomplete',
            getUniqueValues: (devices) => {
                const names = new Set<string>()
                devices.forEach((d) => {
                    const name = d.name?.split('.').shift()
                    if (name) names.add(name)
                })
                return Array.from(names).sort()
            },
        },
        {
            value: 'hostname',
            label: 'Full Hostname',
            description: 'Match against full hostname including domain',
            type: 'autocomplete',
            getUniqueValues: (devices) => {
                const hostnames = new Set<string>()
                devices.forEach((d) => {
                    if (d.hostname) hostnames.add(d.hostname)
                })
                return Array.from(hostnames).sort()
            },
        },
        // Future fields can be added here:
        // { value: 'os', label: 'Operating System', description: 'Match against device OS' },
        // { value: 'user', label: 'User', description: 'Match against device owner' },
    ]
}
