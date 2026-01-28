import { useMemo } from 'react'
import type { NamedCIDRList } from '../../types/task-based-settings'
import type { TailscaleDevice } from '../../types/tailscale'
import { Badge } from '@/components/ui/badge'
import { generateRecordsFromTask } from '../../utils/dns-records'
import { DNSRecordTable } from '../DNSRecordTable'

interface RecordPreviewProps {
    machineSelector: { field: string; pattern: string }
    recordTemplates: any[]
    devices?: TailscaleDevice[]
    cidrLists?: NamedCIDRList[]
}

export function RecordPreview({ machineSelector, recordTemplates, devices = [], cidrLists = [] }: RecordPreviewProps) {

    const preview = useMemo(() => {
        if (!devices.length || !recordTemplates.length) return null

        const tempTask = {
            id: 'preview',
            name: 'Preview Task',
            machineSelector,
            recordTemplates,
            enabled: true
        }

        const limit = 50
        const { records, metadata } = generateRecordsFromTask(
            tempTask,
            devices,
            cidrLists,
            { limit }
        )

        return {
            records,
            totalMatches: metadata.matchedDevices,
            previewLimit: limit
        }
    }, [devices, machineSelector, recordTemplates, cidrLists])

    if (!preview) {
        return null
    }

    return (
        <div className="space-y-4 mt-8 pt-4 border-t">
            <div className="border rounded-lg p-4 bg-muted/50 space-y-3">
                <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">
                        <strong>Preview Records:</strong> Showing first {preview.previewLimit} records (Matches {preview.totalMatches} {preview.totalMatches === 1 ? 'device' : 'devices'})
                    </div>
                </div>

                {preview.records.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground">
                        {devices.length === 0 ? 'No devices available to preview.' : 'No DNS records would be generated with current configuration.'}
                    </div>
                ) : (
                    <DNSRecordTable records={preview.records} />
                )}
            </div>
        </div>
    )
}
