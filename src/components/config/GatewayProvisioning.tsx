'use client'

import { useEffect, useState } from 'react'
import { createGatewayJoinKeyAction, getGatewayProvisioningAction, revokeGatewayJoinKeyAction } from '../../actions'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Section } from '../common/Section'

export function GatewayProvisioning() {
    const [machineName, setMachineName] = useState('')
    const [gatewayHostname, setGatewayHostname] = useState('')
    const [tags, setTags] = useState('')
    const [joinKey, setJoinKey] = useState('')
    const [message, setMessage] = useState('')
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        getGatewayProvisioningAction().then(result => {
            if (result.success && result.gateway) {
                setMachineName(result.gateway.machineName)
                setGatewayHostname(result.gateway.gatewayHostname)
                setTags(result.gateway.tags.join(', '))
                setMessage(`Latest join key ID: ${result.gateway.id}. Expires ${result.gateway.expires}. The key itself is not retained.`)
            }
        })
    }, [])

    async function create(event: React.FormEvent) {
        event.preventDefault()
        setBusy(true)
        setJoinKey('')
        const result = await createGatewayJoinKeyAction({
            machineName: machineName.trim().toLowerCase(),
            gatewayHostname: gatewayHostname.trim().toLowerCase(),
            tags: tags.split(/[\s,]+/).filter(Boolean),
        })
        setBusy(false)
        if (result.success && result.joinKey) {
            setJoinKey(result.joinKey)
            setMessage(`One-use key expires ${result.gateway?.expires ?? 'in one day'}. Copy it now; it will not be shown again.`)
        } else setMessage(result.error ?? 'Key creation failed')
    }

    async function revoke() {
        setBusy(true)
        const result = await revokeGatewayJoinKeyAction()
        setBusy(false)
        if (result.success) { setJoinKey(''); setMessage('Stored join key revoked. Joined devices must be removed in Tailscale admin.') }
        else setMessage(result.error ?? 'Revocation failed')
    }

    return <Section title="Gateway setup" description="Create a one-use join key, then install the gateway before configuring its exposure task.">
        <form onSubmit={create} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
                <div><Label htmlFor="provision-name">Tailscale machine name</Label><Input id="provision-name" required value={machineName} onChange={event => setMachineName(event.target.value)} placeholder="gateway-vps" /></div>
                <div><Label htmlFor="provision-host">Gateway DNS hostname</Label><Input id="provision-host" required value={gatewayHostname} onChange={event => setGatewayHostname(event.target.value)} placeholder="gateway.example.com" /></div>
                <div><Label htmlFor="provision-tags">Tailscale tags</Label><Input id="provision-tags" required value={tags} onChange={event => setTags(event.target.value)} placeholder="tag:server, tag:public" /></div>
            </div>
            <p className="text-sm text-muted-foreground">Tags must be allowed by the Worker’s Tailscale OAuth client. This public page allows anyone to request a key with those tags.</p>
            <div className="flex gap-2"><Button type="submit" disabled={busy}>Create one-use key</Button><Button type="button" variant="outline" disabled={busy} onClick={revoke}>Revoke latest key</Button></div>
        </form>
        {message && <p role="status" className="mt-4 text-sm">{message}</p>}
        {joinKey && <div className="mt-4 space-y-2"><Label htmlFor="join-key">Copy once to the server installer</Label><Input id="join-key" readOnly value={joinKey} onFocus={event => event.currentTarget.select()} /><p className="text-sm">Run <code>./install.sh</code> in the gateway directory on the server and paste this key at its prompt. Then configure the Gateway Exposure task below with the same machine name and DNS hostname.</p></div>}
    </Section>
}
