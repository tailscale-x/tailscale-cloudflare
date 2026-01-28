import { Badge } from '@/components/ui/badge'

interface DNSRecordTableProps {
    records: any[]
    showMachineName?: boolean
    emptyMessage?: string
}

export function DNSRecordTable({
    records,
    showMachineName = true,
    emptyMessage = "No records found."
}: DNSRecordTableProps) {

    if (records.length === 0) {
        return (
            <div className="text-center py-6 text-muted-foreground">
                {emptyMessage}
            </div>
        )
    }

    const formatContent = (record: any) => {
        if (record.type === 'SRV') {
            // Handle GeneratedDNSRecord (flattened fields)
            if (record.priority !== undefined) {
                return `${record.priority} ${record.weight} ${record.port} ${record.content}`
            }
            // Handle Cloudflare RecordResponse (nested data)
            if (record.data) {
                return `${record.data.priority} ${record.data.weight} ${record.data.port} ${record.data.target}`
            }
        }
        return record.content
    }

    const getMachineName = (record: any) => {
        return record.metadata?.machineName || '-'
    }

    // Safely access TTL, it might be undefined on some record types or null
    const getTTL = (record: any) => {
        return record.ttl || 'Auto'
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
                <thead>
                    <tr className="border-b bg-muted/50">
                        {showMachineName && (
                            <th className="text-left p-2 font-semibold text-muted-foreground">Machine</th>
                        )}
                        <th className="text-left p-2 font-semibold text-muted-foreground">Type</th>
                        <th className="text-left p-2 font-semibold text-muted-foreground">Name</th>
                        <th className="text-left p-2 font-semibold text-muted-foreground">Value</th>
                        <th className="text-left p-2 font-semibold text-muted-foreground">TTL</th>
                        <th className="text-left p-2 font-semibold text-muted-foreground">Proxy</th>
                    </tr>
                </thead>
                <tbody>
                    {records.map((record, index) => (
                        <tr key={index} className="border-b hover:bg-muted/50 transition-colors">
                            {showMachineName && (
                                <td className="p-2 font-medium">{getMachineName(record)}</td>
                            )}
                            <td className="p-2">
                                <Badge variant="secondary" className="text-[10px] h-5 rounded-sm px-1.5 font-bold">
                                    {record.type}
                                </Badge>
                            </td>
                            <td className="p-2 font-mono text-xs text-muted-foreground">{record.name}</td>
                            <td className="p-2 font-mono text-xs break-all">
                                {formatContent(record)}
                            </td>
                            <td className="p-2 text-xs text-muted-foreground">{getTTL(record)}s</td>
                            <td className="p-2 text-center text-xs">{record.proxied ? 'proxied' : 'dns only'}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}
