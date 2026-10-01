import ipRangeCheck from 'ip-range-check'
import type { TailscaleDevice } from '../types/tailscale'
import { createRecordComment, getMachineName, type GeneratedDNSRecord } from './dns-records'

export interface ManagedNode {
    id: string
    role: 'gateway' | 'router'
    machineName: string
    gatewayHostname?: string
    revoked: boolean
    lastReportAt: number
    enrolledAt?: number
    exposures: { hostname: string; port: number }[]
}

export function generateRouterExposureRecords(nodes: ManagedNode[], devices: TailscaleDevice[], ownerId: string, now = Date.now()) {
    const records: GeneratedDNSRecord[] = []
    const errors: string[] = []
    const gateway = nodes.filter(node => node.role === 'gateway' && !node.revoked && node.lastReportAt > 0).sort((a, b) => (b.enrolledAt ?? 0) - (a.enrolledAt ?? 0))[0]
    if (!gateway?.gatewayHostname) return { records, errors }
    const zone = gateway.gatewayHostname.split('.').slice(1).join('.')
    const published = new Set<string>()
    for (const node of nodes.filter(node => node.role === 'router' && !node.revoked && now - node.lastReportAt < 600000)) {
        const matches = devices.filter(device => getMachineName(device) === node.machineName)
        const addresses = matches.length === 1 ? (matches[0]?.addresses ?? []).filter(address => ipRangeCheck(address, '100.64.0.0/10')) : []
        if (addresses.length !== 1) {
            errors.push(`Router ${node.machineName} must match one machine with one Tailscale IPv4 address`)
            continue
        }
        const target = `router-${node.id.slice(0, 8)}.ts.${gateway.gatewayHostname}`
        const comment = createRecordComment(node.machineName, ownerId)
        records.push({ type: 'A', name: target, content: addresses[0]!, ttl: 300, proxied: false, comment })
        for (const exposure of node.exposures) {
            const hostname = exposure.hostname.toLowerCase()
            if (!hostname.endsWith(`.${zone}`) || hostname === gateway.gatewayHostname) {
                errors.push(`Router ${node.machineName} reported a hostname outside ${zone}: ${hostname}`)
                continue
            }
            if (!published.has(hostname)) {
                records.push({ type: 'CNAME', name: hostname, content: gateway.gatewayHostname, ttl: 300, proxied: false, comment })
                published.add(hostname)
            }
            records.push({ type: 'SRV', name: `_gateway._tcp.${hostname}`, content: target,
                port: exposure.port, priority: 10, weight: 10, ttl: 300, proxied: false, comment })
        }
    }
    return { records, errors }
}
