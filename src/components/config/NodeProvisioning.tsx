'use client'

import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Section } from '../common/Section'

type Node = { id: string; role: 'gateway' | 'router'; machineName: string; gatewayHostname?: string; revoked?: boolean; expiresAt?: number; lastReportAt?: number }

export function NodeProvisioning() {
    const [role, setRole] = useState<'gateway' | 'router'>('gateway')
    const [machineName, setMachineName] = useState('')
    const [gatewayHostname, setGatewayHostname] = useState('')
    const [tags, setTags] = useState('')
    const [code, setCode] = useState('')
    const [nodes, setNodes] = useState<Node[]>([])
    const [pending, setPending] = useState<Node[]>([])
    const [message, setMessage] = useState('')
    const [busy, setBusy] = useState(false)

    async function refresh() {
        const response = await fetch('/api/nodes')
        if (!response.ok) throw Error(`Node list: HTTP ${response.status}`)
        const result = await response.json() as { nodes: Node[]; pending: Node[] }
        setNodes(result.nodes)
        setPending(result.pending)
    }
    useEffect(() => { refresh().catch(error => setMessage(String(error))) }, [])

    async function issue(event: React.FormEvent) {
        event.preventDefault()
        setBusy(true); setCode('')
        try {
            const response = await fetch('/api/nodes/issue', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role, machineName: machineName.trim().toLowerCase(), gatewayHostname: gatewayHostname.trim().toLowerCase(), tags: tags.split(/[\s,]+/).filter(Boolean) }) })
            const result = await response.json() as { code?: string; expiresAt?: number; error?: string }
            if (!response.ok) throw Error(result.error || `HTTP ${response.status}`)
            setCode(result.code ?? '')
            setMessage(`Enrollment code expires ${new Date(result.expiresAt ?? 0).toLocaleString()}. Copy it now; it is shown once.`)
            await refresh()
        } catch (error) { setMessage(String(error)) }
        finally { setBusy(false) }
    }

    async function revoke(id: string) {
        setBusy(true)
        try {
            const response = await fetch('/api/nodes/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
            const result = await response.json() as { warning?: string; error?: string }
            if (!response.ok) throw Error(result.error || `HTTP ${response.status}`)
            setMessage(result.warning || 'Node revoked. Managed DNS will update on the next sync.')
            await refresh()
        } catch (error) { setMessage(String(error)) }
        finally { setBusy(false) }
    }

    const installer = `node/install.sh --role ${role}`
    return <Section title="Gateway and router nodes" description="Create an enrollment code for each embedded Tailscale node. The installer exchanges it for a one-use auth key; the auth key is never shown here.">
        <form onSubmit={issue} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-4">
                <div><Label htmlFor="node-role">Node role</Label><select id="node-role" className="w-full rounded-md border bg-background p-2" value={role} onChange={event => setRole(event.target.value as 'gateway' | 'router')}><option value="gateway">Gateway</option><option value="router">Docker router</option></select></div>
                <div><Label htmlFor="node-name">Tailscale machine name</Label><Input id="node-name" required value={machineName} onChange={event => setMachineName(event.target.value)} placeholder="gateway-vps" /></div>
                {role === 'gateway' && <div><Label htmlFor="node-host">Gateway DNS hostname</Label><Input id="node-host" required value={gatewayHostname} onChange={event => setGatewayHostname(event.target.value)} placeholder="gateway.example.com" /></div>}
                <div><Label htmlFor="node-tags">Tailscale tags</Label><Input id="node-tags" required value={tags} onChange={event => setTags(event.target.value)} placeholder="tag:server" /></div>
            </div>
            <p className="text-sm text-muted-foreground">This management page is public. Only assign tags allowed by the Worker’s Tailscale OAuth client.</p>
            <Button type="submit" disabled={busy}>Create enrollment code</Button>
        </form>
        {message && <p role="status" className="mt-4 text-sm">{message}</p>}
        {code && <div className="mt-4 space-y-2"><Label htmlFor="enroll-code">Enrollment code</Label><Input id="enroll-code" readOnly value={code} onFocus={event => event.currentTarget.select()} /><p className="text-sm">Run <code>{installer}</code> on the node host, enter this code, and set the Worker URL to <code>{typeof location !== 'undefined' ? location.origin : ''}</code>.</p></div>}
        {role === 'router' && <p className="mt-4 text-sm text-muted-foreground">Attach each HTTP service to the <code>tailscale-cloudflare-ingress</code> Docker network. Set <code>caddy=http://app.example.com:8080</code>, <code>caddy.bind=tailscale/router</code>, and <code>caddy.reverse_proxy={'{{upstreams 3000}}'}</code>, replacing the hostname and container port.</p>}
        <div className="mt-6 space-y-2"><h3 className="font-medium">Nodes and pending codes</h3>{[...nodes, ...pending].length === 0 && <p className="text-sm">No nodes yet.</p>}{[...nodes, ...pending].map(node => <div key={node.id} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm"><span>{node.role} · {node.machineName}{node.gatewayHostname ? ` · ${node.gatewayHostname}` : ''}{node.revoked ? ' · revoked' : node.expiresAt && !node.lastReportAt ? ' · pending' : ''}</span><Button type="button" variant="outline" disabled={busy || node.revoked} onClick={() => revoke(node.id)}>Revoke</Button></div>)}</div>
    </Section>
}
