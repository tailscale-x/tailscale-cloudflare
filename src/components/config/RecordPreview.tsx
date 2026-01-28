'use client'

import { useState } from 'react'
import { previewTaskRecordsAction } from '../../actions'
import type { NamedCIDRList } from '../../types/task-based-settings'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Eye, Loader2 } from 'lucide-react'

interface RecordPreviewProps {
    machineSelector: { field: string; pattern: string }
    recordTemplates: any[]
}

export function RecordPreview({ machineSelector, recordTemplates }: RecordPreviewProps) {
    const [isLoading, setIsLoading] = useState(false)
    const [preview, setPreview] = useState<any>(null)
    const [error, setError] = useState<string | null>(null)

    const loadPreview = async () => {
        setIsLoading(true)
        setError(null)

        try {
            const result = await previewTaskRecordsAction({
                machineSelector,
                recordTemplates,
            })

            if (result.success) {
                setPreview(result)
            } else {
                setError(result.error || 'Failed to load preview')
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="space-y-4 mt-4">
            <Button type="button" onClick={loadPreview} disabled={isLoading || recordTemplates.length === 0} variant="outline" className="w-full sm:w-auto">
                {isLoading ? (
                    <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading...
                    </>
                ) : (
                    <>
                        <Eye className="mr-2 h-4 w-4" />
                        Preview Records
                    </>
                )}
            </Button>

            {error && (
                <Alert variant="destructive">
                    <AlertDescription>
                        <strong>Error:</strong> {error}
                    </AlertDescription>
                </Alert>
            )}

            {preview && (
                <div className="border rounded-lg p-4 bg-muted/50 space-y-3">
                    <div className="text-sm font-medium">
                        <strong>Preview:</strong> Showing first {preview.previewLimit} of {preview.totalMatches} matching{' '}
                        {preview.totalMatches === 1 ? 'machine' : 'machines'}
                    </div>

                    {preview.records.length === 0 ? (
                        <div className="text-center py-6 text-muted-foreground">No DNS records would be generated with current configuration.</div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm border-collapse">
                                <thead>
                                    <tr className="border-b bg-muted">
                                        <th className="text-left p-3 font-semibold">Machine</th>
                                        <th className="text-left p-3 font-semibold">Type</th>
                                        <th className="text-left p-3 font-semibold">Name</th>
                                        <th className="text-left p-3 font-semibold">Value</th>
                                        <th className="text-left p-3 font-semibold">TTL</th>
                                        <th className="text-left p-3 font-semibold">Proxied</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {preview.records.map((record: any, index: number) => (
                                        <tr key={index} className="border-b hover:bg-muted/50 transition-colors">
                                            <td className="p-3">{record.machine}</td>
                                            <td className="p-3">
                                                <Badge variant="secondary" className="text-xs font-semibold">
                                                    {record.recordType}
                                                </Badge>
                                            </td>
                                            <td className="p-3 font-mono text-xs">{record.name}</td>
                                            <td className="p-3 font-mono text-xs">
                                                {record.recordType === 'SRV'
                                                    ? `${record.priority || ''} ${record.weight || ''} ${record.port || ''} ${record.value}`
                                                    : record.value
                                                }
                                            </td>
                                            <td className="p-3">{record.ttl}</td>
                                            <td className="p-3 text-center">{record.proxied ? '🟠' : '⚫'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
