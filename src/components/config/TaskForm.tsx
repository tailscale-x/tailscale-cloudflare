'use client'

import type { GenerationTask, NamedCIDRList, MachineSelector } from '../../types/task-based-settings'
import { FormField } from '../common/FormField'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Separator } from '@/components/ui/separator'
import { MachineSelectorInput } from './MachineSelectorInput'

interface TaskFormProps {
    task: GenerationTask
    cidrLists: NamedCIDRList[]
    onUpdateName: (name: string) => void
    onUpdateDescription: (description: string) => void
    onUpdateSelector: (selector: MachineSelector) => void
}

export function TaskForm({
    task,
    cidrLists,
    onUpdateName,
    onUpdateDescription,
    onUpdateSelector,
}: TaskFormProps) {
    return (
        <div className="space-y-6">
            <div className="space-y-4">
                <FormField
                    label="Task Name"
                    name="task-name"
                    value={task.name}
                    onChange={(e) => onUpdateName(e.target.value)}
                    placeholder="e.g., LAN IP Records"
                />

                <FormField
                    label="Description (optional)"
                    name="task-description"
                    value={task.description || ''}
                    onChange={(e) => onUpdateDescription(e.target.value)}
                    placeholder="Brief description of what this task does"
                />
            </div>

            <Separator />

            <div className="space-y-2">
                <h5 className="font-semibold">Machine Selector</h5>
                <MachineSelectorInput selector={task.machineSelector} onChange={onUpdateSelector} />
            </div>
        </div>
    )
}
