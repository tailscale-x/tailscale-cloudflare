'use client'

import { useState } from 'react'
import type { RecordTemplate, NamedCIDRList } from '../../types/task-based-settings'
import { getAvailableVariables } from '../../utils/template-engine'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Info } from 'lucide-react'

interface RecordTemplateEditorProps {
    template: RecordTemplate
    onChange: (template: RecordTemplate) => void
    onDelete: () => void
    cidrLists: NamedCIDRList[]
}

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'SRV', 'TXT'] as const

export function RecordTemplateEditor({ template, onChange, onDelete, cidrLists }: RecordTemplateEditorProps) {
    const [showHelp, setShowHelp] = useState(false)
    const availableVars = getAvailableVariables(cidrLists)

    const isSRV = template.recordType === 'SRV'
    const supportsProxy = ['A', 'AAAA', 'CNAME'].includes(template.recordType)

    return (
        <Card>
            <CardContent className="pt-6 space-y-4">
                <div className="flex items-center gap-2">
                    <Select
                        value={template.recordType}
                        onValueChange={(value) =>
                            onChange({
                                ...template,
                                recordType: value as RecordTemplate['recordType'],
                            })
                        }
                    >
                        <SelectTrigger className="w-40">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {RECORD_TYPES.map((type) => (
                                <SelectItem key={type} value={type}>
                                    {type} Record
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Button onClick={() => setShowHelp(!showHelp)} variant="outline" size="sm">
                        {showHelp ? 'Hide' : 'Show'} Variables
                    </Button>

                    <Button onClick={onDelete} variant="ghost" size="sm" className="ml-auto text-destructive hover:text-destructive">
                        Remove
                    </Button>
                </div>

                {showHelp && (
                    <Alert className="bg-green-50 border-green-200 text-green-900 dark:bg-green-900/30 dark:border-green-800 dark:text-green-200">
                        <Info className="h-4 w-4 text-green-600 dark:text-green-400" />
                        <AlertDescription>
                            <strong className="block mb-2">Available Template Variables:</strong>
                            <ul className="grid grid-cols-2 md:grid-cols-3 gap-1 mb-2 list-disc list-inside">
                                {availableVars.map((varName) => (
                                    <li key={varName} className="text-sm">
                                        <code className="bg-white dark:bg-gray-800 px-1.5 py-0.5 rounded text-xs">{`{{${varName}}}`}</code>
                                    </li>
                                ))}
                            </ul>
                            <p className="text-sm">
                                Use regex captures like <code className="bg-white dark:bg-gray-800 px-1.5 py-0.5 rounded text-xs">{`{{$1}}`}</code> or{' '}
                                <code className="bg-white dark:bg-gray-800 px-1.5 py-0.5 rounded text-xs">{`{{captureName}}`}</code>
                            </p>
                        </AlertDescription>
                    </Alert>
                )}

                <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label htmlFor="record-name">
                            Record Name Template
                            <span className="block text-xs text-muted-foreground font-normal mt-1">The DNS record name (use variables)</span>
                        </Label>
                        <Input
                            id="record-name"
                            type="text"
                            value={template.name}
                            onChange={(e) => onChange({ ...template, name: e.target.value })}
                            placeholder="{{machineName}}.example.com"
                            className="font-mono"
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="record-value">
                            Record Value Template
                            <span className="block text-xs text-muted-foreground font-normal mt-1">The DNS record content (use variables)</span>
                        </Label>
                        <Input
                            id="record-value"
                            type="text"
                            value={template.value}
                            onChange={(e) => onChange({ ...template, value: e.target.value })}
                            placeholder={template.recordType === 'A' ? '{{cidr.lan}} or {{tailscaleIP}}' : '{{machineName}}.target.com'}
                            className="font-mono"
                        />
                    </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="space-y-2">
                        <Label htmlFor="ttl">TTL (seconds)</Label>
                        <Input
                            id="ttl"
                            type="number"
                            value={template.ttl || 300}
                            onChange={(e) => onChange({ ...template, ttl: parseInt(e.target.value) || 300 })}
                            min="60"
                            max="86400"
                        />
                    </div>

                    {supportsProxy && (
                        <div className="flex items-center space-x-2 pt-8 align-bottom h-full">
                            <Checkbox
                                id="proxied"
                                checked={template.proxied || false}
                                onCheckedChange={(checked) => onChange({ ...template, proxied: checked === true })}
                            />
                            <Label htmlFor="proxied" className="font-normal cursor-pointer">
                                Cloudflare Proxy (orange cloud)
                            </Label>
                        </div>
                    )}

                    {supportsProxy && (
                        <div className="space-y-2 col-span-2 md:col-span-1">
                            <Label htmlFor="srv-prefix" className="flex items-center space-x-2">
                                <span>SRV Prefix (optional)</span>
                            </Label>
                            <Input
                                id="srv-prefix"
                                type="text"
                                value={template.srvPrefix || ''}
                                onChange={(e) => onChange({ ...template, srvPrefix: e.target.value })}
                                placeholder="_http._tcp"
                                className="font-mono"
                            />
                        </div>
                    )}
                </div>

                {(isSRV || (supportsProxy && template.srvPrefix)) && (
                    <div className="p-4 border rounded-lg space-y-4">
                        <div className="font-medium text-sm text-foreground">
                            {isSRV ? 'SRV Record Configuration' : 'Associated SRV Configuration'}
                        </div>
                        <div className="grid grid-cols-3 gap-4">
                            <div className="space-y-2">
                                <Label htmlFor="priority">Priority</Label>
                                <Input
                                    id="priority"
                                    type="number"
                                    value={template.priority || 10}
                                    onChange={(e) => onChange({ ...template, priority: parseInt(e.target.value) || 0 })}
                                    min="0"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="weight">Weight</Label>
                                <Input
                                    id="weight"
                                    type="number"
                                    value={template.weight || 10}
                                    onChange={(e) => onChange({ ...template, weight: parseInt(e.target.value) || 0 })}
                                    min="0"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="port">Port</Label>
                                <Input
                                    id="port"
                                    type="number"
                                    value={template.port || 80}
                                    onChange={(e) => onChange({ ...template, port: parseInt(e.target.value) || 80 })}
                                    min="1"
                                    max="65535"
                                />
                            </div>
                        </div>
                        {/* Target Hostname for Associated SRV (only relevant when srvPrefix is set) */}
                        {template.srvPrefix && !isSRV && (
                            <div className="space-y-2">
                                <Label htmlFor="srv-target">
                                    Target Hostname (Optional)
                                    <span className="block text-xs text-muted-foreground font-normal mt-1">
                                        Defaults to the main record name if left empty. Use variables.
                                    </span>
                                </Label>
                                <Input
                                    id="srv-target"
                                    type="text"
                                    value={template.srvTarget || ''}
                                    onChange={(e) => onChange({ ...template, srvTarget: e.target.value })}
                                    placeholder="Defaults to record name (e.g., {{machineName}}.example.com)"
                                    className="font-mono"
                                />
                            </div>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
