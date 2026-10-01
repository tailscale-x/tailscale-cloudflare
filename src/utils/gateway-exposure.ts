import ipRangeCheck from 'ip-range-check'
import type { GenerationTask, NamedCIDRList } from '../types/task-based-settings'
import type { TailscaleDevice } from '../types/tailscale'
import { createRecordComment, generateRecordsFromTask, getMachineName, type GeneratedDNSRecord } from './dns-records'
import { extractIPsFromEndpoints } from './ip-classifier'
import { selectMachines } from './machine-selector'

const nonPublicRanges = [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
    '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
    '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4',
]

function isPublicIPv4(value: string): boolean {
    const octets = value.split('.').map(Number)
    return octets.length === 4 && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255)
        && !ipRangeCheck(value, nonPublicRanges)
}

export interface GatewayExposureResult {
    records: GeneratedDNSRecord[]
    errors: string[]
    preserveGatewayA?: string
}

/** Generate the gateway address and service records from one gateway exposure task. */
export function generateGatewayExposureRecords(
    task: GenerationTask,
    devices: TailscaleDevice[],
    namedCIDRLists: NamedCIDRList[],
    ownerId: string,
): GatewayExposureResult {
    const exposure = task.gatewayExposure
    if (!exposure) throw new Error('Gateway exposure settings are required')

    const errors: string[] = []
    const records: GeneratedDNSRecord[] = []
    const gatewayName = exposure.gatewayMachineName.toLowerCase()
    const gateways = devices.filter(device => getMachineName(device)?.toLowerCase() === gatewayName)
    const publicIPs = gateways.length === 1
        ? [...new Set(extractIPsFromEndpoints(gateways[0]!.clientConnectivity?.endpoints || []).filter(isPublicIPv4))]
        : []

    const gatewayInvalid = gateways.length !== 1 || publicIPs.length !== 1
    if (gatewayInvalid) {
        errors.push(`Gateway ${exposure.gatewayMachineName} must match one machine with one distinct public IPv4 endpoint; found ${gateways.length} machines and ${publicIPs.length} addresses`)
    } else {
        records.push({
            type: 'A',
            name: exposure.gatewayHostname,
            content: publicIPs[0]!,
            ttl: 300,
            proxied: false,
            comment: createRecordComment(exposure.gatewayMachineName, ownerId),
        })
    }

    const selectedBackends = selectMachines(devices, task.machineSelector).map(({ device }) => device)
    const serviceDevices: TailscaleDevice[] = []
    for (const device of selectedBackends) {
        const tailnetIPs = (device.addresses || []).filter(address =>
            isPublicIPv4(address) === false && ipRangeCheck(address, '100.64.0.0/10'))
        if (tailnetIPs.length !== 1) {
            errors.push(`Backend ${device.name || device.id} must have one Tailscale IPv4 address`)
            continue
        }
        serviceDevices.push({ ...device, addresses: tailnetIPs })
    }

    const serviceTask: GenerationTask = {
        ...task,
        recordTemplates: [
            {
                recordType: 'A',
                name: exposure.backendHostnameTemplate,
                value: '{{tailscaleIP}}',
                ttl: 300,
                proxied: false,
            },
            {
                recordType: 'CNAME',
                name: exposure.publicHostnameTemplate,
                value: exposure.gatewayHostname,
                ttl: 300,
                proxied: false,
                srvPrefix: '_gateway._tcp',
                srvTarget: exposure.backendHostnameTemplate,
                port: exposure.backendPort,
                priority: 10,
                weight: 10,
            },
        ],
    }
    delete serviceTask.gatewayExposure
    const generated = generateRecordsFromTask(serviceTask, serviceDevices, namedCIDRLists, { ownerId })
    records.push(...generated.records)

    return {
        records,
        errors,
        ...(gatewayInvalid ? { preserveGatewayA: exposure.gatewayHostname } : {}),
    }
}
