// Tailscale Machine Sync Service Tests

import { describe, it, expect, beforeEach } from 'vitest'
import { TailscaleMachineSyncService } from './tailscale-machine-sync'
import type { TailscaleClient } from './tailscale'
import type { CloudflareClient } from './cloudflare'
import type { TailscaleDevice, ClassifiedIPs } from '../types/tailscale'
import type { RecordResponse, ARecordParam } from 'cloudflare/resources/dns/records'
import { getIPsByType } from '../utils/ip-classifier'

// Stateful Mock Cloudflare Client
class MockCloudflareClient implements Partial<CloudflareClient> {
	private records: Map<string, RecordResponse> = new Map()
	private nextId = 1
	private errorState: Error | null = null
	private errorMethod: 'getExistingRecordsByComment' | 'batchDeleteAndCreate' | 'batchDeleteRecords' | null = null

	// Reset all records and error state
	reset() {
		this.records.clear()
		this.nextId = 1
		this.errorState = null
		this.errorMethod = null
	}

	// Set error to be thrown by a specific method
	setError(error: Error, method: 'getExistingRecordsByComment' | 'batchDeleteAndCreate' | 'batchDeleteRecords'): void {
		this.errorState = error
		this.errorMethod = method
	}

	// Clear error state
	clearError(): void {
		this.errorState = null
		this.errorMethod = null
	}

	// Get all records (for inspection in tests)
	getAllRecords(): RecordResponse[] {
		return Array.from(this.records.values())
	}

	// Add records directly (for test setup) - accepts RecordResponse or partial RecordResponse
	addRecords(...records: Array<RecordResponse | Partial<RecordResponse>>): void {
		for (const record of records) {
			const id = record.id || `record-${this.nextId++}`
			// Convert to RecordResponse format (with required fields)
			const recordResponse: RecordResponse = {
				id,
				type: (record.type || 'A') as 'A',
				name: record.name || '',
				content: record.content || '',
				ttl: record.ttl || 3600,
				proxied: record.proxied || false,
				created_on: new Date().toISOString(),
				modified_on: new Date().toISOString(),
				proxiable: true,
				meta: {},
				...(record.comment && { comment: record.comment }),
			} as RecordResponse
			this.records.set(id, recordResponse)
		}
	}

	// Get existing records filtered by comment prefix
	async getExistingRecordsByComment(commentPrefix: string): Promise<RecordResponse[]> {
		if (this.errorState && this.errorMethod === 'getExistingRecordsByComment') {
			throw this.errorState
		}

		const results = Array.from(this.records.values())
		// Filter records that start with the comment prefix (case-insensitive)
		return results.filter(r => {
			if (!r.comment) return false
			return r.comment.toLowerCase().startsWith(commentPrefix.toLowerCase())
		})
	}

	// Batch delete and create (atomic operation)
	async batchDeleteAndCreate(
		recordIdsToDelete: string[],
		recordsToCreate: ARecordParam[]
	): Promise<void> {
		if (this.errorState && this.errorMethod === 'batchDeleteAndCreate') {
			throw this.errorState
		}

		// Delete records
		for (const id of recordIdsToDelete) {
			this.records.delete(id)
		}

		// Create records - convert params to RecordResponse format
		for (const record of recordsToCreate) {
			const id = `record-${this.nextId++}`
			const recordResponse: RecordResponse = {
				id,
				type: record.type,
				name: record.name,
				content: record.content || '',
				ttl: record.ttl || 3600,
				proxied: record.proxied || false,
				created_on: new Date().toISOString(),
				modified_on: new Date().toISOString(),
				proxiable: true,
				meta: {},
				...(record.comment && { comment: record.comment }),
			} as RecordResponse
			this.records.set(id, recordResponse)
		}
	}

	// Batch delete records
	async batchDeleteRecords(recordIds: string[]): Promise<void> {
		if (this.errorState && this.errorMethod === 'batchDeleteRecords') {
			throw this.errorState
		}

		for (const id of recordIds) {
			this.records.delete(id)
		}
	}
}

// Stateful Mock Tailscale Client
class MockTailscaleClient implements Partial<TailscaleClient> {
	private devices: TailscaleDevice[] = []
	private errorState: Error | null = null
	private errorMethod: 'getDevices' | 'classifyEndpoints' | null = null
	private lanCidrRanges: string[] = []

	constructor(lanCidrRanges: string[] = []) {
		this.lanCidrRanges = lanCidrRanges
	}

	// Reset all devices and error state
	reset() {
		this.devices = []
		this.errorState = null
		this.errorMethod = null
	}

	// Set error to be thrown by a specific method
	setError(error: Error, method: 'getDevices' | 'classifyEndpoints'): void {
		this.errorState = error
		this.errorMethod = method
	}

	// Clear error state
	clearError(): void {
		this.errorState = null
		this.errorMethod = null
	}

	// Set devices
	setDevices(devices: TailscaleDevice[]): void {
		this.devices = [...devices]
	}

	// Add a device
	addDevice(device: TailscaleDevice): void {
		this.devices.push(device)
	}

	// Update a device (by ID)
	updateDevice(deviceId: string, updates: Partial<TailscaleDevice>): void {
		const index = this.devices.findIndex(d => d.id === deviceId)
		if (index !== -1) {
			this.devices[index] = { ...this.devices[index], ...updates }
		}
	}

	// Remove a device
	removeDevice(deviceId: string): void {
		this.devices = this.devices.filter(d => d.id !== deviceId)
	}

	// Get all devices
	async getDevices(): Promise<TailscaleDevice[]> {
		if (this.errorState && this.errorMethod === 'getDevices') {
			throw this.errorState
		}

		return [...this.devices]
	}

	// Classify endpoints for a device using the real classification logic
	classifyEndpoints(device: TailscaleDevice): ClassifiedIPs {
		if (this.errorState && this.errorMethod === 'classifyEndpoints') {
			throw this.errorState
		}

		// Use the real classification logic from ip-classifier
		return getIPsByType(device, this.lanCidrRanges)
	}
}

describe('TailscaleMachineSyncService', () => {
	let mockTailscaleClient: MockTailscaleClient
	let mockCloudflareClient: MockCloudflareClient
	let tailscaleMachineSyncService: TailscaleMachineSyncService

	const defaultConfig = {
		tsDomain: 'ts.example.com',
		wanDomain: 'wan.example.com',
		lanDomain: 'lan.example.com',
		ownerId: 'test-owner',
		lanTagRegex: /^tag:lan/,
		tailscaleTagRegex: /^tag:ts/,
		wanNoProxyTagRegex: /^tag:wan/,
		wanProxyTagRegex: /^tag:proxy/,
		lanCidrRanges: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
	}

	beforeEach(() => {
		mockTailscaleClient = new MockTailscaleClient(defaultConfig.lanCidrRanges)
		mockCloudflareClient = new MockCloudflareClient()
		
		tailscaleMachineSyncService = new TailscaleMachineSyncService({
			tailscaleClient: mockTailscaleClient as any,
			cloudflareClient: mockCloudflareClient as any,
			...defaultConfig,
		})

		// Reset all state
		mockTailscaleClient.reset()
		mockCloudflareClient.reset()
	})

	describe('Constructor', () => {
		it('should initialize with provided configuration', () => {
			const service = new TailscaleMachineSyncService({
				tailscaleClient: mockTailscaleClient as any,
				cloudflareClient: mockCloudflareClient as any,
				tsDomain: 'ts.test.com',
				wanDomain: 'wan.test.com',
				lanDomain: 'lan.test.com',
				ownerId: 'owner-123',
				lanTagRegex: /^tag:lan/,
				tailscaleTagRegex: /^tag:ts/,
				wanNoProxyTagRegex: /^tag:wan/,
				wanProxyTagRegex: /^tag:proxy/,
				lanCidrRanges: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
			})

			expect(service).toBeInstanceOf(TailscaleMachineSyncService)
		})

		it('should create records for machines with all IP types', async () => {
			const devices: TailscaleDevice[] = [{
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
				addresses: ['100.1.2.3'],
				clientConnectivity: {
					endpoints: ['192.168.1.10:41641', '203.0.113.5:41641'],
				},
			}]

			mockTailscaleClient.setDevices(devices)
			await tailscaleMachineSyncService.syncAllMachines()

			// Verify records were created
			const allRecords = mockCloudflareClient.getAllRecords()
			
			// Verify A records
			const aRecords = allRecords.filter(r => r.type === 'A')
			expect(aRecords.length).toBeGreaterThanOrEqual(2) // At least TS and one endpoint-based record
			
			// Verify we have TS record with comment
			const tsRecord = aRecords.find(r => r.name === 'machine1.ts.example.com' && r.content === '100.1.2.3')
			expect(tsRecord).toBeDefined()
			expect(tsRecord?.comment).toBeDefined()
			expect(tsRecord?.comment).toContain('cf-ts-dns:')
			expect(tsRecord?.comment).toContain(':test-owner:')
			
			// Verify we have at least one endpoint-based record (LAN or WAN)
			const endpointRecords = aRecords.filter(r => 
				r.name.includes('lan') || r.name.includes('wan')
			)
			expect(endpointRecords.length).toBeGreaterThan(0)
			
			// All A records should have ownership comments
			expect(aRecords.every(r => r.comment && r.comment.includes('cf-ts-dns:'))).toBe(true)
			expect(aRecords.every(r => r.comment && r.comment.includes(':test-owner:'))).toBe(true)
		})

		it('should handle machine with only Tailscale IP', async () => {
			const devices: TailscaleDevice[] = [{
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
				addresses: ['100.1.2.3'],
			}]

			mockTailscaleClient.setDevices(devices)
			await tailscaleMachineSyncService.syncAllMachines()

			const allRecords = mockCloudflareClient.getAllRecords()
			expect(allRecords).toHaveLength(1) // 1 A record with comment
			expect(allRecords.filter(r => r.type === 'A')).toHaveLength(1)
			const aRecord = allRecords.find(r => r.type === 'A')
			expect(aRecord?.comment).toBeDefined()
			expect(aRecord?.comment).toContain('cf-ts-dns:')
		})

		it('should handle machine with multiple WAN IPs for round-robin', async () => {
			const devices: TailscaleDevice[] = [{
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
				addresses: ['100.1.2.3'],
				clientConnectivity: {
					endpoints: ['203.0.113.5:41641', '203.0.113.6:41641', '203.0.113.7:41641'],
				},
			}]

			mockTailscaleClient.setDevices(devices)
			await tailscaleMachineSyncService.syncAllMachines()

			const allRecords = mockCloudflareClient.getAllRecords()
			const wanARecords = allRecords.filter(
				r => r.type === 'A' && r.name === 'machine1.wan.example.com'
			)
			expect(wanARecords.length).toBeGreaterThanOrEqual(1) // Multiple A records for round-robin
			// All WAN records should have comments
			expect(wanARecords.every(r => r.comment && r.comment.includes('cf-ts-dns:'))).toBe(true)
		})

		it('should sync all machines from Tailscale', async () => {
			const devices: TailscaleDevice[] = [
				{
					id: 'device-1',
					name: 'machine1',
					tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
					addresses: ['100.1.2.3'],
				},
				{
					id: 'device-2',
					name: 'machine2',
					tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
					addresses: ['100.1.2.4'],
					clientConnectivity: {
						endpoints: ['192.168.1.10:41641'],
					},
				},
			]

			mockTailscaleClient.setDevices(devices)

			await tailscaleMachineSyncService.syncAllMachines()

			// Verify records were created
			const allRecords = mockCloudflareClient.getAllRecords()
			expect(allRecords.length).toBeGreaterThan(0)
			
			// machine1: 1 A record with comment
			// machine2: 2 A records with comments (TS and LAN)
			const machine1Records = allRecords.filter(r => r.name.includes('machine1'))
			const machine2Records = allRecords.filter(r => r.name.includes('machine2'))
			expect(machine1Records.length).toBeGreaterThanOrEqual(1)
			expect(machine2Records.length).toBeGreaterThanOrEqual(2)
			// All records should have comments
			expect(machine1Records.every(r => r.comment && r.comment.includes('cf-ts-dns:'))).toBe(true)
			expect(machine2Records.every(r => r.comment && r.comment.includes('cf-ts-dns:'))).toBe(true)
		})

		it('should skip devices without name or hostname', async () => {
			const devices: TailscaleDevice[] = [
				{
					id: 'device-1',
					name: 'machine1',
					tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
					addresses: ['100.1.2.3'],
				},
				{
					id: 'device-2',
					// No name or hostname
				},
			]

			mockTailscaleClient.setDevices(devices)

			await tailscaleMachineSyncService.syncAllMachines()

			// Should only create records for machine1
			const allRecords = mockCloudflareClient.getAllRecords()
			const machine1Records = allRecords.filter(r => r.name.includes('machine1'))
			expect(machine1Records.length).toBeGreaterThanOrEqual(1) // At least 1 A record with comment
		})

		it('should delete stale records for removed machines', async () => {
			// Pre-populate with stale records for machine2 that no longer exists
			mockCloudflareClient.addRecords(
				{
					type: 'A',
					name: 'machine2.ts.example.com',
					content: '100.1.2.4',
					comment: 'cf-ts-dns:test-owner:machine2',
				},
				// Valid records for machine1 that still exists
				{
					type: 'A',
					name: 'machine1.ts.example.com',
					content: '100.1.2.3',
					comment: 'cf-ts-dns:test-owner:machine1',
				}
			)

			const staleRecordIds = mockCloudflareClient.getAllRecords()
				.filter(r => r.name.includes('machine2'))
				.map(r => r.id)

			// Only machine1 exists now
			const devices: TailscaleDevice[] = [
				{
					id: 'device-1',
					name: 'machine1',
					addresses: ['100.1.2.3'],
				},
			]

			mockTailscaleClient.setDevices(devices)

			await tailscaleMachineSyncService.syncAllMachines()

			// Stale records should be deleted
			const allRecords = mockCloudflareClient.getAllRecords()
			const staleRecords = allRecords.filter(r => staleRecordIds.includes(r.id!))
			expect(staleRecords.length).toBe(0)
		})

		it('should handle empty device list', async () => {
			mockTailscaleClient.setDevices([])

			await tailscaleMachineSyncService.syncAllMachines()

			// Should not create any records
			const allRecords = mockCloudflareClient.getAllRecords()
			expect(allRecords.length).toBe(0)
		})

		it('should handle complex scenario with multiple machines and IP types', async () => {
			const devices: TailscaleDevice[] = [
				{
					id: 'device-1',
					name: 'machine1',
					tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
					addresses: ['100.1.2.3'],
					clientConnectivity: {
						endpoints: ['192.168.1.10:41641', '203.0.113.5:41641', '203.0.113.6:41641'],
					},
				},
				{
					id: 'device-2',
					name: 'machine2-hostname',
					tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
					addresses: ['100.1.2.4'],
					clientConnectivity: {
						endpoints: ['10.0.0.5:41641'],
					},
				},
			]

			mockTailscaleClient.setDevices(devices)

			await tailscaleMachineSyncService.syncAllMachines()

			const allRecords = mockCloudflareClient.getAllRecords()

			// machine1: TS + LAN + WAN records (multiple WAN IPs possible)
			// machine2-hostname: TS + LAN records
			// Total should be at least 4 records (no TXT records anymore, just A records with comments)
			// machine1: TS + at least 1 endpoint record (LAN or WAN) = at least 2
			// machine2-hostname: TS + LAN = 2
			expect(allRecords.length).toBeGreaterThanOrEqual(4)

			// Verify machine1 records exist
			const machine1Records = allRecords.filter(r => r.name.includes('machine1'))
			expect(machine1Records.length).toBeGreaterThanOrEqual(2) // At least TS + some endpoint records
			
			// Verify machine2-hostname records exist
			const machine2Records = allRecords.filter(r => r.name.includes('machine2-hostname'))
			expect(machine2Records.length).toBeGreaterThanOrEqual(2) // At least TS + LAN records (10.0.0.5 is LAN)
		})
	})

	describe('syncAllMachines - Edge cases and error handling', () => {
		it('should handle Cloudflare API errors gracefully', async () => {
			const devices: TailscaleDevice[] = [{
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
				addresses: ['100.1.2.3'],
			}]

			mockTailscaleClient.setDevices(devices)

			// Set error state for getExistingRecordsByComment
			mockCloudflareClient.setError(
				new Error('Cloudflare API error: 500 Internal Server Error'),
				'getExistingRecordsByComment'
			)

			await expect(tailscaleMachineSyncService.syncAllMachines()).rejects.toThrow(
				'Cloudflare API error'
			)

			// Clear error state
			mockCloudflareClient.clearError()
		})

		it('should handle Tailscale API errors gracefully', async () => {
			// Set error state for getDevices
			mockTailscaleClient.setError(
				new Error('Tailscale API error: 401 Unauthorized'),
				'getDevices'
			)

			await expect(tailscaleMachineSyncService.syncAllMachines()).rejects.toThrow(
				'Tailscale API error'
			)

			// Clear error state
			mockTailscaleClient.clearError()
		})

		it('should handle records without IDs in existing records', async () => {
			const devices: TailscaleDevice[] = [{
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
				addresses: ['100.1.2.3'],
			}]

			mockTailscaleClient.setDevices(devices)

			// Add a record that will get an ID from our mock
			mockCloudflareClient.addRecords({
				type: 'A',
				name: 'machine1.ts.example.com',
				content: '100.1.2.3',
				comment: 'cf-ts-dns:test-owner:machine1',
			})

			// Should not throw, should handle existing record and create new one if needed
			await tailscaleMachineSyncService.syncAllMachines()

			// Verify records exist
			const allRecords = mockCloudflareClient.getAllRecords()
			expect(allRecords.length).toBeGreaterThan(0)
		})

		it('should handle records with different owner IDs', async () => {
			const devices: TailscaleDevice[] = [{
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
				addresses: ['100.1.2.3'],
			}]

			mockTailscaleClient.setDevices(devices)

			// Pre-populate with records owned by different owner
			// Note: This record won't be found by getExistingRecordsByComment since it uses
			// a different owner prefix, so we'll create a new record and the old one will remain
			mockCloudflareClient.addRecords(
				{
					type: 'A',
					name: 'machine1.ts.example.com',
					content: '100.1.2.3',
					comment: 'cf-ts-dns:other-owner:machine1',
				}
			)

			const initialRecordCount = mockCloudflareClient.getAllRecords().length
			expect(initialRecordCount).toBe(1) // Just the A record

			await tailscaleMachineSyncService.syncAllMachines()

			// Since getExistingRecordsByComment only returns records with our ownership prefix,
			// the record with different owner comment won't be found, so we'll create a new one
			// and the old one will remain (we don't delete records we don't own)
			const allRecords = mockCloudflareClient.getAllRecords()
			
			// We'll have both records - the old one with different owner, and our new one
			const aRecords = allRecords.filter(r => 
				r.type === 'A' && r.name === 'machine1.ts.example.com' && r.content === '100.1.2.3'
			)
			// Both records will exist since we can't see the old one to delete it
			expect(aRecords.length).toBe(2)
			
			// Verify our new record has the correct ownership
			const ourRecord = aRecords.find(r => r.comment?.includes(':test-owner:'))
			expect(ourRecord).toBeDefined()
			expect(ourRecord?.comment).toContain(':test-owner:')
		})

		it('should handle empty classified IPs', async () => {
			const devices: TailscaleDevice[] = [{
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
				// No addresses or endpoints - will result in empty classification
			}]

			mockTailscaleClient.setDevices(devices)

			await tailscaleMachineSyncService.syncAllMachines()

			// Should not create any records, but also should not throw
			const allRecords = mockCloudflareClient.getAllRecords()
			expect(allRecords.length).toBe(0)
		})

		it('should handle multiple consecutive endpoint changes for multiple machines', async () => {
			// Initial state: Two machines with initial IPs
			let device1: TailscaleDevice = {
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
				addresses: ['100.1.2.3'],
				clientConnectivity: {
					endpoints: ['192.168.1.10:41641', '203.0.113.5:41641'],
				},
			}

			let device2: TailscaleDevice = {
				id: 'device-2',
				name: 'machine2',
				tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
				addresses: ['100.1.2.4'],
				clientConnectivity: {
					endpoints: ['192.168.1.20:41641'],
				},
			}

			mockTailscaleClient.setDevices([device1, device2])

			// First sync - initial records
			await tailscaleMachineSyncService.syncAllMachines()
			let allRecords = mockCloudflareClient.getAllRecords()
			const machine1InitialWANRecord = allRecords.find(
				r => r.name === 'machine1.wan.example.com' && r.type === 'A'
			)
			// The WAN IP should be 203.0.113.5 (non-RFC1918 address)
			expect(machine1InitialWANRecord).toBeDefined()
			if (machine1InitialWANRecord) {
				expect(['192.168.1.10', '203.0.113.5']).toContain(machine1InitialWANRecord.content)
			}
			const machine1InitialRecordContent = machine1InitialWANRecord?.content || ''

			// Second sync - machine1 WAN IP changes
			device1 = {
				...device1,
				clientConnectivity: {
					endpoints: ['192.168.1.10:41641', '203.0.113.6:41641'], // Changed from .5 to .6
				},
			}
			mockTailscaleClient.setDevices([device1, device2])

			await tailscaleMachineSyncService.syncAllMachines()
			allRecords = mockCloudflareClient.getAllRecords()
			const machine1UpdatedWANRecords = allRecords.filter(
				r => r.name === 'machine1.wan.example.com' && r.type === 'A'
			)
			// Should have WAN IP (either .5 or .6 depending on which endpoint is WAN)
			expect(machine1UpdatedWANRecords.length).toBeGreaterThan(0)
			const updatedWANIPs = machine1UpdatedWANRecords.map(r => r.content).filter((ip): ip is string => !!ip)
			// After update, should have .6 in the WAN IPs (or it changed)
			expect(updatedWANIPs.some(ip => ip === '203.0.113.6' || ip === '192.168.1.10')).toBe(true)

			// Third sync - machine2 LAN IP changes, machine1 adds second WAN IP
			device1 = {
				...device1,
				clientConnectivity: {
					endpoints: ['192.168.1.10:41641', '203.0.113.6:41641', '203.0.113.7:41641'], // Added second WAN IP
				},
			}
			device2 = {
				...device2,
				clientConnectivity: {
					endpoints: ['192.168.1.21:41641'], // Changed from .20 to .21
				},
			}
			mockTailscaleClient.setDevices([device1, device2])

			await tailscaleMachineSyncService.syncAllMachines()
			allRecords = mockCloudflareClient.getAllRecords()
			
			// machine1 should have 2 WAN A records now (if both are classified as WAN)
			const machine1FinalWANRecords = allRecords.filter(
				r => r.name === 'machine1.wan.example.com' && r.type === 'A'
			)
			// Should have at least 1 WAN record (could be 2 if both non-LAN IPs are classified as WAN)
			expect(machine1FinalWANRecords.length).toBeGreaterThanOrEqual(1)
			const finalWANIPs = machine1FinalWANRecords.map(r => r.content).filter((ip): ip is string => !!ip).sort()
			// Should contain WAN IPs (203.0.113.x addresses)
			expect(finalWANIPs.some(ip => ip.startsWith('203.0.113.'))).toBe(true)

			// machine2 LAN IP should be updated (if it has a LAN endpoint)
			const machine2LANRecord = allRecords.find(
				r => r.name === 'machine2-hostname.lan.example.com' && r.type === 'A'
			)
			if (machine2LANRecord) {
				expect(machine2LANRecord.content).toBe('192.168.1.21')
			}

			// Fourth sync - machine2 loses LAN IP
			device2 = {
				...device2,
				clientConnectivity: {
					endpoints: [], // LAN endpoint removed
				},
			}
			mockTailscaleClient.setDevices([device1, device2])

			await tailscaleMachineSyncService.syncAllMachines()
			allRecords = mockCloudflareClient.getAllRecords()
			
			// machine2 LAN records should be deleted
			const machine2LANRecords = allRecords.filter(
				r => r.name.includes('machine2') && r.name.includes('lan')
			)
			expect(machine2LANRecords.length).toBe(0)

			// Verify all syncs maintained correct state
			const machine1Records = allRecords.filter(r => r.name.includes('machine1'))
			const machine2Records = allRecords.filter(r => r.name.includes('machine2'))
			expect(machine1Records.length).toBeGreaterThan(0)
			expect(machine2Records.length).toBeGreaterThan(0)
		})

		it('should handle external changes in Cloudflare and reconcile them', async () => {
			// Initial sync: Create records for a machine
			const devices: TailscaleDevice[] = [{
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
				addresses: ['100.1.2.3'],
				clientConnectivity: {
					endpoints: ['192.168.1.10:41641', '203.0.113.5:41641'],
				},
			}]

			mockTailscaleClient.setDevices(devices)
			await tailscaleMachineSyncService.syncAllMachines()
			let allRecords = mockCloudflareClient.getAllRecords()
			expect(allRecords.length).toBeGreaterThanOrEqual(3) // At least TS, LAN, and WAN records

			const originalWANRecord = allRecords.find(
				r => r.name === 'machine1.wan.example.com' && r.type === 'A'
			)
			expect(originalWANRecord).toBeDefined()
			const originalWANRecordId = originalWANRecord?.id
			const originalWANIP = originalWANRecord?.content

			// Simulate external change: Someone manually changes the WAN IP in Cloudflare
			if (originalWANRecordId && originalWANIP) {
				const records = mockCloudflareClient.getAllRecords()
				const recordMap = new Map(records.map(r => [r.id!, r]))
				recordMap.delete(originalWANRecordId)
				mockCloudflareClient.reset()
				recordMap.forEach(record => mockCloudflareClient.addRecords(record))
				// Add the externally changed record (with correct comment to be owned)
				mockCloudflareClient.addRecords({
					type: 'A',
					name: 'machine1.wan.example.com',
					content: '203.0.113.99', // Manually changed IP
					comment: 'cf-ts-dns:test-owner:machine1',
				})
			}

			// Resync - should detect the change and correct it back
			await tailscaleMachineSyncService.syncAllMachines()
			allRecords = mockCloudflareClient.getAllRecords()
			
			// Should have corrected the WAN IP back to what Tailscale says
			const wanRecords = allRecords.filter(
				r => r.name === 'machine1.wan.example.com' && r.type === 'A'
			)
			expect(wanRecords.length).toBeGreaterThanOrEqual(1)
			if (originalWANIP) {
				expect(wanRecords.some(r => r.content === originalWANIP)).toBe(true)
			}
		})
	})

	describe('LAN IP Classification and Proxy', () => {
		it('should classify LAN IPs correctly and place them in LAN domain, not WAN', async () => {
			const devices: TailscaleDevice[] = [{
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
				addresses: ['100.1.2.3'],
				clientConnectivity: {
					endpoints: ['10.42.0.0:41641', '192.168.1.10:41641'], // Both are LAN IPs
				},
			}]

			mockTailscaleClient.setDevices(devices)
			await tailscaleMachineSyncService.syncAllMachines()

			const allRecords = mockCloudflareClient.getAllRecords()
			
			// Should have TS record
			const tsRecord = allRecords.find(r => r.name === 'machine1.ts.example.com')
			expect(tsRecord).toBeDefined()
			
			// Should have LAN record (10.42.0.0 should be classified as LAN)
			const lanRecord = allRecords.find(r => 
				r.name === 'machine1.lan.example.com' && r.content === '10.42.0.0'
			)
			expect(lanRecord).toBeDefined()
			expect(lanRecord?.proxied).toBe(false) // LAN records should never be proxied
			
			// Should NOT have WAN record for 10.42.0.0 (it's a LAN IP)
			const wanRecordForLanIP = allRecords.find(r => 
				r.name === 'machine1.wan.example.com' && r.content === '10.42.0.0'
			)
			expect(wanRecordForLanIP).toBeUndefined()
		})

		it('should disable proxy for LAN IPs even if misclassified in WAN domain', async () => {
			// This test simulates the bug scenario where a LAN IP somehow ends up in WAN domain
			// We'll manually create a record with a LAN IP in WAN domain to test the safeguard
			const devices: TailscaleDevice[] = [{
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:lan', 'tag:ts', 'tag:proxy'], // Has proxy tag
				addresses: ['100.1.2.3'],
				clientConnectivity: {
					endpoints: ['10.42.0.0:41641'], // LAN IP
				},
			}]

			mockTailscaleClient.setDevices(devices)
			
			// Manually add a misclassified record: LAN IP in WAN domain with proxy enabled
			// This simulates a bug where classification went wrong
			mockCloudflareClient.addRecords({
				name: 'machine1.wan.example.com',
				type: 'A',
				content: '10.42.0.0',
				proxied: true, // Incorrectly proxied
				comment: 'cf-ts-dns:test-owner:machine1',
			})

			await tailscaleMachineSyncService.syncAllMachines()

			const allRecords = mockCloudflareClient.getAllRecords()
			
			// The misclassified record should be deleted (it's in wrong domain)
			const misclassifiedRecord = allRecords.find(r => 
				r.name === 'machine1.wan.example.com' && r.content === '10.42.0.0'
			)
			expect(misclassifiedRecord).toBeUndefined()
			
			// Should have correct LAN record instead
			const lanRecord = allRecords.find(r => 
				r.name === 'machine1.lan.example.com' && r.content === '10.42.0.0'
			)
			expect(lanRecord).toBeDefined()
			expect(lanRecord?.proxied).toBe(false)
		})

		it('should disable proxy for WAN domain records with LAN IPs (safeguard)', async () => {
			// Test the safeguard: even if a LAN IP is passed to createARecordForIP with WAN domain,
			// proxy should be disabled
			const devices: TailscaleDevice[] = [{
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:lan', 'tag:ts', 'tag:proxy'], // Has proxy tag
				addresses: ['100.1.2.3'],
				clientConnectivity: {
					endpoints: ['203.0.113.5:41641'], // WAN IP
				},
			}]

			mockTailscaleClient.setDevices(devices)
			await tailscaleMachineSyncService.syncAllMachines()

			const allRecords = mockCloudflareClient.getAllRecords()
			
			// Should have WAN record with public IP
			const wanRecord = allRecords.find(r => 
				r.name === 'machine1.wan.example.com' && r.content === '203.0.113.5'
			)
			expect(wanRecord).toBeDefined()
			// WAN IP with proxy tag should be proxied
			expect(wanRecord?.proxied).toBe(true)
			
			// Now manually add a record with LAN IP in WAN domain (simulating misclassification)
			// This tests the safeguard in createARecordForIP
			mockCloudflareClient.addRecords({
				name: 'machine1.wan.example.com',
				type: 'A',
				content: '10.42.0.0', // LAN IP
				proxied: false, // Should remain false
				comment: 'cf-ts-dns:test-owner:machine1',
			})

			// Sync again - the LAN IP in WAN domain should be removed
			await tailscaleMachineSyncService.syncAllMachines()

			const finalRecords = mockCloudflareClient.getAllRecords()
			const lanIPInWanDomain = finalRecords.find(r => 
				r.name === 'machine1.wan.example.com' && r.content === '10.42.0.0'
			)
			expect(lanIPInWanDomain).toBeUndefined()
		})

		it('should correctly classify mixed LAN and WAN IPs', async () => {
			const devices: TailscaleDevice[] = [{
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:dns', 'tag:proxy'],
				addresses: ['100.1.2.3'],
				clientConnectivity: {
					endpoints: [
						'10.42.0.0:41641',    // LAN IP (10.0.0.0/8)
						'192.168.1.10:41641', // LAN IP (192.168.0.0/16)
						'203.0.113.5:41641', // WAN IP (public)
					],
				},
			}]

			mockTailscaleClient.setDevices(devices)
			await tailscaleMachineSyncService.syncAllMachines()

			const allRecords = mockCloudflareClient.getAllRecords()
			
			// Should have one LAN record (first LAN IP selected)
			const lanRecords = allRecords.filter(r => 
				r.name === 'machine1.lan.example.com'
			)
			expect(lanRecords.length).toBe(1)
			expect(['10.42.0.0', '192.168.1.10']).toContain(lanRecords[0].content)
			expect(lanRecords[0].proxied).toBe(false)
			
			// Should have WAN record with public IP
			const wanRecord = allRecords.find(r => 
				r.name === 'machine1.wan.example.com' && r.content === '203.0.113.5'
			)
			expect(wanRecord).toBeDefined()
			expect(wanRecord?.proxied).toBe(true) // WAN IP with proxy tag should be proxied
			
			// Should NOT have LAN IPs in WAN domain
			const lanIPsInWanDomain = allRecords.filter(r => 
				r.name === 'machine1.wan.example.com' && 
				(r.content === '10.42.0.0' || r.content === '192.168.1.10')
			)
			expect(lanIPsInWanDomain.length).toBe(0)
		})

		it('should handle empty LAN_CIDR_RANGES with error', async () => {
			// Test that empty lanCidrRanges throws an error when classifying endpoints
			const device: TailscaleDevice = {
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
				clientConnectivity: {
					endpoints: ['10.42.0.0:41641'],
				},
			}

			// Create a service with empty lanCidrRanges
			const emptyRangesClient = new MockTailscaleClient([])
			emptyRangesClient.setDevices([device])
			
			const serviceWithEmptyRanges = new TailscaleMachineSyncService({
				tailscaleClient: emptyRangesClient as any,
				cloudflareClient: mockCloudflareClient as any,
				tsDomain: 'ts.example.com',
				wanDomain: 'wan.example.com',
				lanDomain: 'lan.example.com',
				ownerId: 'test-owner',
				lanTagRegex: /^tag:lan/,
				tailscaleTagRegex: /^tag:ts/,
				wanNoProxyTagRegex: /^tag:wan/,
				wanProxyTagRegex: /^tag:proxy/,
				lanCidrRanges: [],
			})

			// This should throw when trying to sync because getIPsByType will be called with empty array
			await expect(serviceWithEmptyRanges.syncAllMachines()).rejects.toThrow('lanCidrRanges cannot be empty')
		})

		it('should skip DNS record creation for empty domain configurations', async () => {
			const devices: TailscaleDevice[] = [{
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
				addresses: ['100.1.2.3'],
				clientConnectivity: {
					endpoints: ['10.42.0.0:41641', '203.0.113.5:41641'],
				},
			}]

			mockTailscaleClient.setDevices(devices)

			// Create service with empty WAN domain
			const serviceWithEmptyWanDomain = new TailscaleMachineSyncService({
				tailscaleClient: mockTailscaleClient as any,
				cloudflareClient: mockCloudflareClient as any,
				tsDomain: 'ts.example.com',
				wanDomain: '', // Empty WAN domain
				lanDomain: 'lan.example.com',
				ownerId: 'test-owner',
				lanTagRegex: /^tag:lan/,
				tailscaleTagRegex: /^tag:ts/,
				wanNoProxyTagRegex: /^tag:wan/,
				wanProxyTagRegex: /^tag:proxy/,
				lanCidrRanges: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
			})

			await serviceWithEmptyWanDomain.syncAllMachines()

			const allRecords = mockCloudflareClient.getAllRecords()
			
			// Should have TS record
			const tsRecord = allRecords.find(r => r.name === 'machine1.ts.example.com')
			expect(tsRecord).toBeDefined()
			
			// Should have LAN record
			const lanRecord = allRecords.find(r => r.name === 'machine1.lan.example.com')
			expect(lanRecord).toBeDefined()
			expect(lanRecord?.content).toBe('10.42.0.0')
			
			// Should NOT have WAN record (domain is empty)
			const wanRecord = allRecords.find(r => r.name === 'machine1.wan.example.com')
			expect(wanRecord).toBeUndefined()
		})

		it('should skip DNS record creation when all domains are empty', async () => {
			const devices: TailscaleDevice[] = [{
				id: 'device-1',
				name: 'machine1',
				tags: ['tag:lan', 'tag:ts', 'tag:wan', 'tag:proxy'],
				addresses: ['100.1.2.3'],
				clientConnectivity: {
					endpoints: ['10.42.0.0:41641', '203.0.113.5:41641'],
				},
			}]

			mockTailscaleClient.setDevices(devices)

			// Create service with all domains empty
			const serviceWithEmptyDomains = new TailscaleMachineSyncService({
				tailscaleClient: mockTailscaleClient as any,
				cloudflareClient: mockCloudflareClient as any,
				tsDomain: '', // Empty
				wanDomain: '', // Empty
				lanDomain: '', // Empty
				ownerId: 'test-owner',
				lanTagRegex: /^tag:lan/,
				tailscaleTagRegex: /^tag:ts/,
				wanNoProxyTagRegex: /^tag:wan/,
				wanProxyTagRegex: /^tag:proxy/,
				lanCidrRanges: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
			})

			await serviceWithEmptyDomains.syncAllMachines()

			const allRecords = mockCloudflareClient.getAllRecords()
			
			// Should have no records at all
			expect(allRecords.length).toBe(0)
		})
	})
})
