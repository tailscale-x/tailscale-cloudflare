// Task-Based DNS Record Generation Service

import type { TailscaleDevice } from '../types/tailscale'
import type {
    RecordResponse,
    ARecordParam,
    AAAARecordParam,
    CNAMERecordParam,
    TXTRecordParam,
    SRVRecordParam,
} from 'cloudflare/resources/dns/records'
import type { TaskBasedSettings, GenerationTask, RecordTemplate } from '../types/task-based-settings'
import { TailscaleClient } from './tailscale-client'
import { CloudflareClient } from './cloudflare'
import { createLogger } from '../utils/logger'
import { selectMachines } from '../utils/machine-selector'
import { evaluateTemplate, type TemplateContext } from '../utils/template-engine'
import { extractIPsFromEndpoints } from '../utils/ip-classifier'

const logger = createLogger()

/**
 * DNS record that can be any supported type
 */
type DNSRecord = ARecordParam | AAAARecordParam | CNAMERecordParam | TXTRecordParam | SRVRecordParam

/**
 * Result of DNS synchronization operation
 */
export interface TaskBasedSyncResult {
    added: DNSRecord[]
    deleted: Array<Pick<RecordResponse, 'id' | 'name' | 'type' | 'content'>>
    summary: {
        addedCount: number
        deletedCount: number
        totalDevices: number
        matchedDevices: number
    }
    managed: RecordResponse[]
}

export class TaskBasedDNSService {
    // Constants for DNS record comment format
    private static readonly HERITAGE = 'cf-ts-dns'
    private static readonly DEFAULT_TTL = 3600
    private static readonly BATCH_SIZE = 200

    private tailscaleClient: TailscaleClient
    private cloudflareClient: CloudflareClient
    private settings: TaskBasedSettings
    private ownerId: string

    constructor(
        settings: TaskBasedSettings,
        ownerId: string,
        clients?: {
            tailscaleClient?: TailscaleClient
            cloudflareClient?: CloudflareClient
        }
    ) {
        this.settings = settings
        this.ownerId = ownerId

        this.tailscaleClient = clients?.tailscaleClient || new TailscaleClient({
            apiKey: settings.TAILSCALE_API_KEY,
            tailnet: settings.TAILSCALE_TAILNET,
        })

        this.cloudflareClient = clients?.cloudflareClient || new CloudflareClient({
            apiToken: settings.CLOUDFLARE_API_TOKEN,
        })
    }

    /**
     * Static factory method that creates service and performs sync
     */
    static async performSync(
        settings: TaskBasedSettings,
        ownerId: string,
        dryRun: boolean = false
    ): Promise<TaskBasedSyncResult> {
        logger.info(`Creating task-based DNS sync service with owner ID: ${ownerId}`)
        const service = new TaskBasedDNSService(settings, ownerId)
        return service.syncAllMachines(dryRun)
    }

    /**
     * Extract machine name from device
     */
    private getMachineName(device: TailscaleDevice): string | null {
        return device.name?.split('.').shift() || null
    }

    /**
     * Create record comment for ownership tracking
     */
    private createRecordComment(machineName: string): string {
        const base = `${TaskBasedDNSService.HERITAGE}:${this.ownerId}:`
        const maxLength = 100

        if (base.length + machineName.length <= maxLength) {
            return `${base}${machineName}`
        }

        const availableLength = maxLength - base.length
        const truncatedMachineName = machineName.substring(0, Math.max(0, availableLength))
        return `${base}${truncatedMachineName}`
    }

    /**
     * Check if record is owned by this service
     */
    private isOwnedRecord(comment: string | undefined): boolean {
        if (!comment) return false
        return (
            comment.includes(`${TaskBasedDNSService.HERITAGE}:`) &&
            comment.includes(`:${this.ownerId}:`)
        )
    }

    /**
     * Generate record key for map lookups
     * Includes type, name, and content to handle multiple records with same name/type
     */
    private getRecordKey(record: DNSRecord | RecordResponse): string {
        const type = record.type
        const name = record.name

        // SRV records have data instead of content
        if (type === 'SRV') {
            const data = 'data' in record ? (record.data as any) : (record as any).data
            if (data) {
                return `${type}:${name}:${data.service}:${data.proto}:${data.priority}:${data.weight}:${data.port}:${data.target}`
            }
        }

        const content = 'content' in record ? (record.content as string) : (record as any).content
        if (content) {
            return `${type}:${name}:${content}`
        }

        return `${type}:${name}`
    }

    /**
     * Extract Tailscale IP from device addresses
     */
    private getTailscaleIP(device: TailscaleDevice): string {
        if (device.addresses && device.addresses.length > 0) {
            const tailscaleIPs = device.addresses.filter(addr => {
                // Tailscale IPs are typically in 100.x.y.z range or fd7a: for IPv6
                return addr.startsWith('100.') || addr.startsWith('fd7a:')
            })
            if (tailscaleIPs.length > 0) {
                return tailscaleIPs[0]!
            }
        }
        return ''
    }

    /**
     * Build template context for a device
     */
    private buildTemplateContext(
        device: TailscaleDevice,
        machineName: string,
        captures: Record<string, string>
    ): TemplateContext {
        return {
            machineName,
            tailscaleIP: this.getTailscaleIP(device),
            tags: device.tags || [],
            captures,
            namedCIDRLists: this.settings.namedCIDRLists,
            device,
        }
    }

    /**
     * Create DNS record from template
     */
    private createRecordFromTemplate(
        template: RecordTemplate,
        recordName: string,
        recordValue: string,
        machineName: string
    ): DNSRecord | null {
        const comment = this.createRecordComment(machineName)
        const ttl = template.ttl || TaskBasedDNSService.DEFAULT_TTL

        switch (template.recordType) {
            case 'A':
                return {
                    type: 'A',
                    name: recordName,
                    content: recordValue,
                    ttl,
                    comment,
                    proxied: template.proxied || false,
                } as ARecordParam

            case 'AAAA':
                return {
                    type: 'AAAA',
                    name: recordName,
                    content: recordValue,
                    ttl,
                    comment,
                    proxied: template.proxied || false,
                } as AAAARecordParam

            case 'CNAME':
                return {
                    type: 'CNAME',
                    name: recordName,
                    content: recordValue,
                    ttl,
                    comment,
                    proxied: template.proxied || false,
                } as CNAMERecordParam

            case 'SRV':
                // SRV record format: priority weight port target
                // Service and protocol are part of the recordName
                const srvPriority = template.priority ?? 10
                const srvWeight = template.weight ?? 10
                const srvPort = template.port ?? 80

                return {
                    type: 'SRV',
                    name: recordName,
                    data: {
                        priority: srvPriority,
                        weight: srvWeight,
                        port: srvPort,
                        target: recordValue,
                    },
                    ttl,
                    comment,
                } as SRVRecordParam

            case 'TXT':
                return {
                    type: 'TXT',
                    name: recordName,
                    content: recordValue,
                    ttl,
                    comment,
                } as TXTRecordParam

            default:
                logger.warn(`Unsupported record type: ${template.recordType}`)
                return null
        }
    }

    /**
     * Generate DNS records from a single task for matched devices
     */
    private generateRecordsFromTask(task: GenerationTask, devices: TailscaleDevice[]): {
        records: DNSRecord[]
    } {
        const records: DNSRecord[] = []

        // Select machines matching the task selector
        const selectedMachines = selectMachines(devices, task.machineSelector)
        logger.info(`Task "${task.name}": matched ${selectedMachines.length} devices`)

        for (const { device, captures } of selectedMachines) {
            const machineName = this.getMachineName(device)
            if (!machineName) {
                logger.warn(`Skipping device ${device.id} - no name or hostname`)
                continue
            }

            // Build template context
            const context = this.buildTemplateContext(device, machineName, captures)

            // Process each record template
            for (const template of task.recordTemplates) {
                // Evaluate name template
                const nameResult = evaluateTemplate(template.name, context)
                if (nameResult.error || nameResult.values.length === 0) {
                    logger.warn(`Failed to evaluate name template for task "${task.name}": ${nameResult.error}`)
                    continue
                }

                // Evaluate value template
                const valueResult = evaluateTemplate(template.value, context)
                if (valueResult.error || valueResult.values.length === 0) {
                    logger.warn(`Failed to evaluate value template for task "${task.name}": ${valueResult.error}`)
                    continue
                }

                // Generate records for each combination (handles multiple IPs from CIDR extraction)
                for (const recordName of nameResult.values) {
                    for (const recordValue of valueResult.values) {
                        // Skip empty values
                        if (!recordValue || recordValue.trim() === '') {
                            continue
                        }

                        const record = this.createRecordFromTemplate(template, recordName, recordValue, machineName)
                        if (record) {
                            records.push(record)
                        }
                    }
                }
            }
        }

        return { records }
    }

    /**
     * Convert records array to map keyed by type:name:content
     * If duplicates exist in Cloudflare, they are identified and others are marked for deletion
     */
    private recordsToMap(records: RecordResponse[]): {
        recordMap: Map<string, RecordResponse>,
        duplicates: RecordResponse[]
    } {
        const recordMap = new Map<string, RecordResponse>()
        const duplicates: RecordResponse[] = []

        for (const record of records) {
            if (record.id && record.type && record.name) {
                const key = this.getRecordKey(record)
                if (recordMap.has(key)) {
                    // This is a duplicate record on Cloudflare side
                    duplicates.push(record)
                } else {
                    recordMap.set(key, record)
                }
            }
        }
        return { recordMap, duplicates }
    }

    /**
     * Perform diff between expected and existing records
     */
    private performDiff(
        expectedRecords: DNSRecord[],
        expectedKeys: Set<string>,
        existingRecords: Map<string, RecordResponse>,
        cloudflareDuplicates: RecordResponse[]
    ): {
        toCreate: DNSRecord[]
        toDelete: RecordResponse[]
    } {
        const toCreate: DNSRecord[] = []
        const toDelete: RecordResponse[] = [...cloudflareDuplicates] // All duplicates in Cloudflare should be deleted

        // Check each expected record
        for (const expectedRecord of expectedRecords) {
            const key = this.getRecordKey(expectedRecord)
            const existing = existingRecords.get(key)

            if (!existing) {
                // New record
                toCreate.push(expectedRecord)
            } else {
                // Check if record needs update (comment, or proxied changed)
                // Content is already part of the key now
                const needsUpdate =
                    ('comment' in expectedRecord && existing.comment !== expectedRecord.comment) ||
                    ('proxied' in expectedRecord && existing.proxied !== expectedRecord.proxied)

                if (needsUpdate && existing.id) {
                    toDelete.push(existing)
                    toCreate.push(expectedRecord)
                }
            }
        }

        // Find stale records
        for (const [key, existingRecord] of existingRecords.entries()) {
            if (!expectedKeys.has(key) && existingRecord.id) {
                if (this.isOwnedRecord(existingRecord.comment)) {
                    toDelete.push(existingRecord)
                }
            }
        }

        return { toCreate, toDelete }
    }

    private async executeBatchOperations(
        recordsToDelete: RecordResponse[],
        recordsToCreate: DNSRecord[]
    ): Promise<void> {
        if (recordsToDelete.length === 0 && recordsToCreate.length === 0) {
            return
        }

        // Split into batches
        let deleteIdx = 0
        let createIdx = 0

        while (deleteIdx < recordsToDelete.length || createIdx < recordsToCreate.length) {
            const remainingOps = TaskBasedDNSService.BATCH_SIZE
            const deleteBatch: RecordResponse[] = []
            const createBatch: DNSRecord[] = []

            while (deleteIdx < recordsToDelete.length && deleteBatch.length + createBatch.length < remainingOps) {
                const record = recordsToDelete[deleteIdx++]
                if (record) deleteBatch.push(record)
            }

            while (createIdx < recordsToCreate.length && deleteBatch.length + createBatch.length < remainingOps) {
                const record = recordsToCreate[createIdx++]
                if (record) createBatch.push(record)
            }

            if (deleteBatch.length > 0 || createBatch.length > 0) {
                await this.cloudflareClient.batchDeleteAndCreate(deleteBatch, createBatch)
            }
        }
    }

    /**
     * Get all managed DNS records
     */
    private async getAllManagedRecords(): Promise<RecordResponse[]> {
        const ownershipPrefix = `${TaskBasedDNSService.HERITAGE}:${this.ownerId}:`
        return await this.cloudflareClient.getExistingRecordsByComment(ownershipPrefix)
    }

    /**
     * Sync all machines using task-based generation
     */
    async syncAllMachines(dryRun: boolean = false): Promise<TaskBasedSyncResult> {
        logger.info('Starting task-based DNS synchronization')
        const devices = await this.tailscaleClient.getDevices()
        logger.info(`Found ${devices.length} devices from Tailscale`)

        // Build expected records from all enabled tasks
        const expectedRecordsMap = new Map<string, DNSRecord>()
        let totalMatchedDevices = 0

        for (const task of this.settings.generationTasks) {
            if (!task.enabled) {
                logger.info(`Skipping disabled task: ${task.name}`)
                continue
            }

            logger.info(`Processing task: ${task.name}`)
            const { records } = this.generateRecordsFromTask(task, devices)

            // Add to expected records map
            for (const record of records) {
                const key = this.getRecordKey(record)
                expectedRecordsMap.set(key, record)
            }

            // Count matched devices
            const matched = selectMachines(devices, task.machineSelector).length
            totalMatchedDevices = Math.max(totalMatchedDevices, matched)
        }

        // Get existing managed records
        const existingManagedRecords = await this.getAllManagedRecords()
        const { recordMap: existingRecordsMap, duplicates: cloudflareDuplicates } = this.recordsToMap(existingManagedRecords)

        // Convert expected records map to arrays
        const expectedRecords = Array.from(expectedRecordsMap.values())
        const expectedKeys = new Set(expectedRecordsMap.keys())

        // Perform diff
        const { toCreate, toDelete } = this.performDiff(expectedRecords, expectedKeys, existingRecordsMap, cloudflareDuplicates)

        // Execute operations
        if (toDelete.length > 0 || toCreate.length > 0) {
            if (!dryRun) {
                logger.info(`Executing batch operations: ${toDelete.length} deletes, ${toCreate.length} creates`)
                await this.executeBatchOperations(toDelete, toCreate)
                logger.info('Batch operations completed successfully')
            } else {
                logger.info(`DRY RUN: Would execute ${toDelete.length} deletes, ${toCreate.length} creates`)
            }
        } else {
            logger.info('No DNS changes required - all records are up to date')
        }

        return {
            added: toCreate,
            deleted: toDelete.map(r => ({
                id: r.id!,
                name: r.name,
                type: r.type,
                content: r.content || '',
            })),
            summary: {
                addedCount: toCreate.length,
                deletedCount: toDelete.length,
                totalDevices: devices.length,
                matchedDevices: totalMatchedDevices,
            },
            managed: existingManagedRecords,
        }
    }
}
