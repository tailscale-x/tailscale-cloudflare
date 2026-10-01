'use client'

import type { GenerationTask } from '../../types/task-based-settings'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Props {
    task: GenerationTask
    onChange: (task: GenerationTask) => void
}

export function GatewayExposureForm({ task, onChange }: Props) {
    const exposure = task.gatewayExposure!
    const update = (changes: Partial<typeof exposure>) => onChange({
        ...task,
        gatewayExposure: { ...exposure, ...changes },
    })
    const fields: Array<{ key: keyof typeof exposure; label: string; hint: string }> = [
        { key: 'gatewayMachineName', label: 'Gateway Tailscale machine name', hint: 'Exact gateway node name, such as gateway-vps' },
        { key: 'gatewayHostname', label: 'Gateway DNS hostname', hint: 'gateway.example.com' },
        { key: 'publicHostnameTemplate', label: 'Public hostname template', hint: '{{machineName}}.example.com' },
        { key: 'backendHostnameTemplate', label: 'Backend hostname template', hint: '{{machineName}}.ts.example.com' },
    ]

    return <div className="space-y-5">
        <p className="text-sm text-muted-foreground">Creates a DNS-only gateway A record and, for each selected backend, a tailnet A record, public CNAME, and _gateway._tcp SRV record.</p>
        <div className="grid gap-4 md:grid-cols-2">
            {fields.map(field => <div className="space-y-2" key={field.key}>
                <Label htmlFor={field.key}>{field.label}</Label>
                <Input id={field.key} value={String(exposure[field.key])} placeholder={field.hint}
                    onChange={event => update({ [field.key]: event.target.value })} />
            </div>)}
            <div className="space-y-2">
                <Label htmlFor="gateway-backend-port">Backend HTTP port</Label>
                <Input id="gateway-backend-port" type="number" min={1} max={65535}
                    value={exposure.backendPort}
                    onChange={event => update({ backendPort: Number(event.target.value) })} />
            </div>
        </div>
    </div>
}
