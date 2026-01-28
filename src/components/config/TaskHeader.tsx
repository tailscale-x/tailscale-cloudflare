'use client'

import type { GenerationTask } from '../../types/task-based-settings'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface TaskHeaderProps {
    task: GenerationTask
    isExpanded: boolean
    onToggleExpand: () => void
    onDelete: () => void
}

export function TaskHeader({ task, isExpanded, onToggleExpand, onDelete }: TaskHeaderProps) {
    return (
        <div
            className={cn(
                'flex items-center justify-between p-4 bg-muted/50 cursor-pointer hover:bg-muted/70 transition-colors',
                'border-b'
            )}
            onClick={onToggleExpand}
        >
            <div className="flex items-center gap-4 flex-1">
                <div className="flex-1">
                    <h4 className="font-semibold text-base">{task.name}</h4>
                    {task.description && <p className="text-sm text-muted-foreground mt-0.5">{task.description}</p>}
                </div>
            </div>

            <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                <Badge variant="secondary" className="text-xs">
                    {task.recordTemplates.length} template(s)
                </Badge>
                <Button type="button" onClick={onDelete} variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                    Delete Task
                </Button>
                <Button type="button" variant="ghost" size="sm" className="p-2">
                    {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
            </div>
        </div>
    )
}
