
import type { TailscaleDevice } from '../types/tailscale'
import type { NamedCIDRList, RecordTemplate, GenerationTask } from '../types/task-based-settings'
import { selectMachines } from './machine-selector'
import { evaluateTemplate } from './template-engine'

// Common definition for a generated DNS record
export interface GeneratedDNSRecord {
    type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'SRV'
    name: string
    content: string // value/target
    ttl: number
    proxied: boolean
    comment?: string | undefined
    // SRV specific
    priority?: number | undefined
    weight?: number | undefined
    port?: number | undefined
    // Metadata for UI/Debugging
    metadata?: {
        machineName?: string
        [key: string]: any
    } | undefined
}

export interface GenerationResult {
    records: GeneratedDNSRecord[]
    metadata: {
        matchedDevices: number
    }
}

/**
 * Extract machine name from device
 */
export function getMachineName(device: TailscaleDevice): string | null {
    return device.name?.split('.').shift() || null
}

/**
 * Extract Tailscale IP from device (100.x or fd7a:)
 */
export function getTailscaleIP(device: TailscaleDevice): string {
    if (device.addresses && device.addresses.length > 0) {
        const tailscaleIPs = device.addresses.filter(addr => {
            return addr.startsWith('100.') || addr.startsWith('fd7a:')
        })
        if (tailscaleIPs.length > 0) {
            return tailscaleIPs[0]!
        }
    }
    return ''
}

/**
 * Create record comment for ownership tracking
 */
export function createRecordComment(machineName: string, ownerId?: string): string | undefined {
    if (!ownerId) return undefined

    // Heritage format: cf-ts-dns:ownerId:machineName
    const HERITAGE = 'cf-ts-dns'
    const base = `${HERITAGE}:${ownerId}:`
    const maxLength = 100

    if (base.length + machineName.length <= maxLength) {
        return `${base}${machineName}`
    }

    const availableLength = maxLength - base.length
    const truncatedMachineName = machineName.substring(0, Math.max(0, availableLength))
    return `${base}${truncatedMachineName}`
}

/**
 * Generate DNS records for a specific task and device list
 * 
 * @param task The generation task containing selector and templates
 * @param devices List of available Tailscale devices
 * @param namedCIDRLists Available CIDR lists for templates
 * @param options optional configuration like ownerId for comments
 */
export function generateRecordsFromTask(
    task: GenerationTask,
    devices: TailscaleDevice[],
    namedCIDRLists: NamedCIDRList[] = [],
    options: { ownerId?: string, limit?: number } = {}
): GenerationResult {
    const records: GeneratedDNSRecord[] = []

    // Select machines matching the task selector
    const selectedMachines = selectMachines(devices, task.machineSelector)

    for (const { device, captures } of selectedMachines) {
        // Enforce limit if provided (useful for previews)
        if (options.limit && records.length >= options.limit) break

        const machineName = getMachineName(device)
        if (!machineName) continue

        // Build template context
        const context = {
            machineName,
            tailscaleIP: getTailscaleIP(device),
            tags: device.tags || [],
            captures,
            namedCIDRLists,
            device,
        }

        const comment = options.ownerId ? createRecordComment(machineName, options.ownerId) : undefined

        // Process each record template
        for (const template of task.recordTemplates) {
            // Evaluate name template
            const nameResult = evaluateTemplate(template.name, context)
            if (nameResult.error || nameResult.values.length === 0) continue

            // Evaluate value template
            const valueResult = evaluateTemplate(template.value, context)
            if (valueResult.error || valueResult.values.length === 0) continue

            // Generate records for each combination
            for (const recordName of nameResult.values) {
                for (const recordValue of valueResult.values) {
                    if (!recordValue || recordValue.trim() === '') continue

                    // Common record props
                    const baseRecord = {
                        name: recordName,
                        content: recordValue,
                        ttl: template.ttl || 300,
                        proxied: template.proxied || false,
                        comment,
                        metadata: { machineName }
                    }

                    // Add main record
                    if (template.recordType === 'SRV') {
                        records.push({
                            type: 'SRV',
                            ...baseRecord,
                            // Content for SRV normally is target, but we store specific SRV fields too
                            priority: template.priority ?? 10,
                            weight: template.weight ?? 10,
                            port: template.port ?? 80,
                        })
                    } else {
                        records.push({
                            type: template.recordType as any,
                            ...baseRecord,
                        })
                    }

                    // Associate SRV Record logic
                    if (
                        template.srvPrefix &&
                        ['A', 'AAAA', 'CNAME'].includes(template.recordType)
                    ) {
                        const srvName = `${template.srvPrefix}.${recordName}`
                        records.push({
                            type: 'SRV',
                            name: srvName,
                            content: recordName, // Target is the name of the main record
                            ttl: template.ttl || 300,
                            proxied: false,
                            priority: template.priority ?? 10,
                            weight: template.weight ?? 10,
                            port: template.port ?? 80,
                            comment,
                            metadata: { machineName }
                        })
                    }
                }
            }
        }
    }

    return {
        records,
        metadata: {
            matchedDevices: selectedMachines.length
        }
    }
}
