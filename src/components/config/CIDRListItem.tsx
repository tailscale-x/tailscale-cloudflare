'use client'

import { useState, useEffect } from 'react'
import type { NamedCIDRList } from '../../types/task-based-settings'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'

interface CIDRListItemProps {
    list: NamedCIDRList
    usageCount: number
    isEditing: boolean
    onToggleEdit: () => void
    onDelete: () => void
    onSave: () => void
    onUpdateDescription: (description: string) => void
    onUpdateCIDRs: (cidrsText: string) => void
    onUpdateMode: (mode: 'single' | 'multiple') => void
    onUpdateInverse: (inverse: boolean) => void
}

export function CIDRListItem({
    list,
    usageCount,
    isEditing,
    onToggleEdit,
    onDelete,
    onSave,
    onUpdateDescription,
    onUpdateCIDRs,
    onUpdateMode,
    onUpdateInverse,
}: CIDRListItemProps) {
    const inUse = usageCount > 0
    const [localCidrs, setLocalCidrs] = useState('')

    // Synchronize local state when editing starts or when list.cidrs actually changes
    useEffect(() => {
        if (!isEditing) return

        const currentCidrs = localCidrs
            .split(',')
            .map((c) => c.trim())
            .filter((c) => c.length > 0)

        // Only update if the semantic content actually differs to avoid wiping out trailing commas/spaces
        const contentHasChanged =
            currentCidrs.length !== list.cidrs.length || currentCidrs.some((cidr, i) => cidr !== list.cidrs[i])

        if (contentHasChanged) {
            setLocalCidrs(list.cidrs.join(', '))
        }
    }, [isEditing, list.cidrs])

    return (
        <Card className={cn('transition-colors', isEditing && 'border-primary')}>
            <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <h4 className="font-semibold text-base">{list.name}</h4>
                        {inUse && (
                            <Badge variant="secondary" className="text-xs">
                                {usageCount} task(s)
                            </Badge>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        {isEditing && (
                            <Button type="button" onClick={onSave} size="sm" className="h-8">
                                Save
                            </Button>
                        )}
                        <Button type="button" onClick={onToggleEdit} variant="ghost" size="sm">
                            {isEditing ? 'Close' : 'Edit'}
                        </Button>
                        <Button
                            type="button"
                            onClick={onDelete}
                            variant="ghost"
                            size="sm"
                            disabled={inUse}
                            className="text-destructive hover:text-destructive"
                            title={inUse ? 'Cannot delete - in use by tasks' : 'Delete this CIDR list'}
                        >
                            Delete
                        </Button>
                    </div>
                </div>
            </CardHeader>

            <CardContent>
                {isEditing ? (
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor={`desc-${list.name}`}>Description (optional)</Label>
                            <Input
                                id={`desc-${list.name}`}
                                type="text"
                                value={list.description || ''}
                                onChange={(e) => onUpdateDescription(e.target.value)}
                                placeholder="Brief description of this network"
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor={`cidrs-${list.name}`}>
                                CIDR Ranges (comma-separated)
                                <span className="block text-xs text-muted-foreground font-normal mt-1">
                                    Example: 192.168.1.0/24, 10.0.0.0/8
                                </span>
                            </Label>
                            <Textarea
                                id={`cidrs-${list.name}`}
                                value={localCidrs}
                                onChange={(e) => {
                                    setLocalCidrs(e.target.value)
                                    onUpdateCIDRs(e.target.value)
                                }}
                                placeholder="192.168.0.0/16, 10.0.0.0/8"
                                rows={3}
                                className="font-mono text-sm"
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label htmlFor={`mode-${list.name}`}>Matching Mode</Label>
                                <Select value={list.mode || 'multiple'} onValueChange={(v) => onUpdateMode(v as 'single' | 'multiple')}>
                                    <SelectTrigger id={`mode-${list.name}`}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="multiple">Multiple (All Matches)</SelectItem>
                                        <SelectItem value="single">Single (First Match)</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-2">
                                <Label>Options</Label>
                                <div className="flex items-center space-x-2 h-10">
                                    <Checkbox
                                        id={`inverse-${list.name}`}
                                        checked={list.inverse || false}
                                        onCheckedChange={(checked) => onUpdateInverse(checked === true)}
                                    />
                                    <Label htmlFor={`inverse-${list.name}`} className="font-normal cursor-pointer">
                                        Invert Matching (Not)
                                    </Label>
                                </div>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {list.description && <p className="text-sm text-muted-foreground">{list.description}</p>}
                        <p className="text-sm font-mono">
                            <span className="font-semibold text-muted-foreground">Ranges:</span> {list.cidrs.join(', ')}
                        </p>
                        <div className="flex gap-2">
                            <Badge variant="outline">Mode: {list.mode === 'single' ? 'Single' : 'Multiple'}</Badge>
                            {list.inverse && <Badge variant="destructive">Inverted</Badge>}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
