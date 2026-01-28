// CIDR List Manager
// Manages named CIDR lists with validation and usage tracking

import type { NamedCIDRList, GenerationTask } from '../types/task-based-settings'
import { classifyIP } from './ip-classifier'

/**
 * Helper to check if a task uses a specific CIDR list in its templates
 */
function doesTaskUseCIDRList(task: GenerationTask, cidrListName: string): boolean {
    const variableRegex = /\{\{([^}]+)\}\}/g

    for (const template of task.recordTemplates) {
        // Check both name and value templates
        const templates = [template.name, template.value]
        for (const t of templates) {
            let match
            // Reset regex for each string
            variableRegex.lastIndex = 0
            while ((match = variableRegex.exec(t)) !== null) {
                const variable = match[1]?.trim() || ''
                if (variable.startsWith('cidr.')) {
                    const cidrSpec = variable.substring(5)
                    const names = cidrSpec.split(',').map(n => n.trim())
                    if (names.includes(cidrListName)) {
                        return true
                    }
                }
            }
        }
    }
    return false
}

/**
 * Check if a CIDR list is referenced by any generation task
 */
export function isCIDRListInUse(cidrListName: string, tasks: GenerationTask[]): boolean {
    return tasks.some((task) => doesTaskUseCIDRList(task, cidrListName))
}

/**
 * Get usage count for a CIDR list
 */
export function getCIDRListUsageCount(cidrListName: string, tasks: GenerationTask[]): number {
    return tasks.filter((task) => doesTaskUseCIDRList(task, cidrListName)).length
}

/**
 * Get all tasks referencing a CIDR list
 */
export function getTasksUsingCIDRList(cidrListName: string, tasks: GenerationTask[]): GenerationTask[] {
    return tasks.filter((task) => doesTaskUseCIDRList(task, cidrListName))
}

/**
 * Validate CIDR list before deletion
 */
export function canDeleteCIDRList(
    cidrListName: string,
    tasks: GenerationTask[]
): { canDelete: boolean; error?: string } {
    if (isCIDRListInUse(cidrListName, tasks)) {
        const usageCount = getCIDRListUsageCount(cidrListName, tasks)
        return {
            canDelete: false,
            error: `Cannot delete CIDR list "${cidrListName}" - it is referenced by ${usageCount} task(s) in their DNS templates`,
        }
    }

    return { canDelete: true }
}

/**
 * Check if an IP matches any CIDR in a named list
 */
export function matchesNamedCIDRList(ip: string, cidrListName: string, namedCIDRLists: NamedCIDRList[]): boolean {
    const cidrList = namedCIDRLists.find((list) => list.name === cidrListName)
    if (!cidrList) {
        return false
    }

    return classifyIP(ip, cidrList.cidrs)
}

/**
 * Extract first IP matching a named CIDR list from array of IPs
 * Respects CIDR list ordering (first matching range wins)
 */
export function extractFirstMatchingIP(
    ips: string[],
    cidrListName: string,
    namedCIDRLists: NamedCIDRList[]
): string | undefined {
    const cidrList = namedCIDRLists.find((list) => list.name === cidrListName)
    if (!cidrList) {
        return undefined
    }

    // Check each CIDR range in order
    for (const range of cidrList.cidrs) {
        for (const ip of ips) {
            if (classifyIP(ip, [range])) {
                return ip
            }
        }
    }

    return undefined
}

/**
 * Extract all IPs matching a named CIDR list
 */
export function extractAllMatchingIPs(
    ips: string[],
    cidrListName: string,
    namedCIDRLists: NamedCIDRList[]
): string[] {
    const cidrList = namedCIDRLists.find((list) => list.name === cidrListName)
    if (!cidrList) {
        return []
    }

    const matchingIPs: string[] = []

    // Check each CIDR range in order, collecting matches
    for (const range of cidrList.cidrs) {
        for (const ip of ips) {
            if (classifyIP(ip, [range]) && !matchingIPs.includes(ip)) {
                matchingIPs.push(ip)
            }
        }
    }

    return matchingIPs
}

/**
 * Validate CIDR list name uniqueness
 */
export function isCIDRListNameUnique(name: string, existingLists: NamedCIDRList[]): boolean {
    return !existingLists.some((list) => list.name === name)
}

/**
 * Find CIDR list by name
 */
export function findCIDRListByName(name: string, namedCIDRLists: NamedCIDRList[]): NamedCIDRList | undefined {
    return namedCIDRLists.find((list) => list.name === name)
}
