// Template Engine for DNS Record Generation

import type { TailscaleDevice } from '../types/tailscale'
import type { NamedCIDRList } from '../types/task-based-settings'
import { extractIPsFromEndpoints, classifyIP } from './ip-classifier'

/**
 * Template context for variable substitution
 */
export interface TemplateContext {
    machineName: string
    tailscaleIP?: string
    tags: string[]
    captures: Record<string, string> // Regex capture groups (numbered and named)
    namedCIDRLists: NamedCIDRList[]
    device: TailscaleDevice
}

/**
 * Template evaluation result
 * Can produce multiple values when template references multiple IPs (e.g., from CIDR list)
 */
export interface TemplateResult {
    values: string[] // Can be multiple values for round-robin DNS
    error?: string
}

/**
 * Extract IPs matching a named CIDR list from device endpoints
 */
function extractIPsMatchingCIDRList(
    device: TailscaleDevice,
    cidrListName: string,
    namedCIDRLists: NamedCIDRList[]
): string[] {
    const cidrList = namedCIDRLists.find((list) => list.name === cidrListName)
    if (!cidrList) {
        return []
    }

    const endpoints = device.clientConnectivity?.endpoints || []
    const endpointIPs = extractIPsFromEndpoints(endpoints)

    const matchingIPs: string[] = []
    const isInverse = cidrList.inverse === true

    if (isInverse) {
        // Inverse matching: Include IPs that do NOT match ANY of the CIDR ranges
        for (const ip of endpointIPs) {
            // Check if IP matches any range in the list
            const matchesAny = cidrList.cidrs.some((range) => classifyIP(ip, [range]))

            // If it matches none, include it
            if (!matchesAny && !matchingIPs.includes(ip)) {
                matchingIPs.push(ip)
            }
        }
    } else {
        // Standard matching: Include IPs that match AT LEAST ONE CIDR range
        // Respect order of ranges as defined in the list
        for (const range of cidrList.cidrs) {
            for (const ip of endpointIPs) {
                if (classifyIP(ip, [range]) && !matchingIPs.includes(ip)) {
                    matchingIPs.push(ip)
                }
            }
        }
    }

    // Check mode setting
    if (cidrList.mode === 'single' && matchingIPs.length > 0) {
        // Return only the first match
        return [matchingIPs[0] as string]
    }

    return matchingIPs
}

/**
 * Parse template string and extract variables
 * Variables are in the format: {{variableName}} or {{cidr.listName}}
 */
function parseTemplate(template: string): string[] {
    const variableRegex = /\{\{([^}]+)\}\}/g
    const variables: string[] = []
    let match: RegExpExecArray | null

    while ((match = variableRegex.exec(template)) !== null) {
        variables.push(match[1].trim())
    }

    return variables
}

/**
 * Resolve a single variable from the template context
 * Returns an array of values (can be multiple for CIDR extraction)
 */
function resolveVariable(variable: string, context: TemplateContext): string[] {
    // Handle CIDR extraction: {{cidr.listName}} or {{cidr.list1,list2}}
    if (variable.startsWith('cidr.')) {
        const cidrSpec = variable.substring(5) // Remove 'cidr.' prefix
        const cidrListNames = cidrSpec.split(',').map(name => name.trim())

        const allIPs: string[] = []
        for (const cidrListName of cidrListNames) {
            const ips = extractIPsMatchingCIDRList(context.device, cidrListName, context.namedCIDRLists)
            for (const ip of ips) {
                if (!allIPs.includes(ip)) {
                    allIPs.push(ip)
                }
            }
        }
        return allIPs // Return empty if no IPs found, prevents generation
    }

    // Handle regex captures: {{$1}}, {{$2}}, or {{$captureName}}
    if (variable.startsWith('$')) {
        const captureKey = variable.substring(1)
        const value = context.captures[captureKey]
        return value ? [value] : []
    }

    // Handle standard variables
    switch (variable) {
        case 'machineName':
            return [context.machineName]
        case 'tailscaleIP':
            return context.tailscaleIP ? [context.tailscaleIP] : []
        case 'tags':
            // Tags list is always valid, even if empty string
            return [context.tags.join(',')]
        default:
            // Check if it's a capture group name
            if (context.captures[variable]) {
                return [context.captures[variable]]
            }
            return [] // Unknown variable -> no value
    }
}

/**
 * Evaluate a template with the given context
 * Returns multiple values if template contains CIDR extraction with multiple IPs
 */
export function evaluateTemplate(template: string, context: TemplateContext): TemplateResult {
    try {
        const variables = parseTemplate(template)

        // If no variables, return template as-is
        if (variables.length === 0) {
            return { values: [template] }
        }

        // Check if any variable produces multiple values
        let hasMultipleValues = false
        const variableValues = new Map<string, string[]>()

        for (const variable of variables) {
            const values = resolveVariable(variable, context)

            // If any variable fails to resolve to a value, the entire template yields no results
            if (values.length === 0) {
                return { values: [] }
            }

            variableValues.set(variable, values)
            if (values.length > 1) {
                hasMultipleValues = true
            }
        }

        // If multiple values exist, generate one template result per combination
        if (hasMultipleValues) {
            // Find the first variable with multiple values and expand for each value
            // (Simple implementation: expand only the first multi-value variable)
            const results: string[] = []

            for (const variable of variables) {
                const values = variableValues.get(variable) || ['']
                if (values.length > 1) {
                    // Generate one result for each value
                    for (const value of values) {
                        let result = template
                        // Replace this variable
                        result = result.replace(new RegExp(`\\{\\{\\s*${escapeRegex(variable)}\\s*\\}\\}`, 'g'), value)
                        // Replace other variables with their single values
                        for (const [otherVar, otherValues] of variableValues.entries()) {
                            if (otherVar !== variable) {
                                result = result.replace(
                                    new RegExp(`\\{\\{\\s*${escapeRegex(otherVar)}\\s*\\}\\}`, 'g'),
                                    otherValues[0] || ''
                                )
                            }
                        }
                        results.push(result)
                    }
                    return { values: results }
                }
            }
        }

        // Single-value substitution
        let result = template
        for (const [variable, values] of variableValues.entries()) {
            result = result.replace(new RegExp(`\\{\\{\\s*${escapeRegex(variable)}\\s*\\}\\}`, 'g'), values[0] || '')
        }

        return { values: [result] }
    } catch (error) {
        return {
            values: [],
            error: `Template evaluation error: ${error instanceof Error ? error.message : String(error)}`,
        }
    }
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Validate template syntax
 */
export function validateTemplate(template: string): { valid: boolean; error?: string } {
    try {
        const variables = parseTemplate(template)

        // Check for unclosed braces
        const openBraces = (template.match(/\{\{/g) || []).length
        const closeBraces = (template.match(/\}\}/g) || []).length

        if (openBraces !== closeBraces) {
            return {
                valid: false,
                error: 'Unclosed template braces - ensure all {{...}} are properly closed',
            }
        }

        // Check for empty variables
        for (const variable of variables) {
            if (!variable || variable.trim() === '') {
                return {
                    valid: false,
                    error: 'Empty variable name in template',
                }
            }
        }

        return { valid: true }
    } catch (error) {
        return {
            valid: false,
            error: `Template syntax error: ${error instanceof Error ? error.message : String(error)}`,
        }
    }
}

/**
 * Get all available variables for template context
 */
export function getAvailableVariables(namedCIDRLists: NamedCIDRList[]): string[] {
    const variables = ['machineName', 'tailscaleIP', 'tags']

    // Add CIDR list variables
    for (const list of namedCIDRLists) {
        variables.push(`cidr.${list.name}`)
    }

    return variables
}
