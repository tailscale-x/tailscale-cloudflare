'use client'

import { useState, useTransition, type FormEvent } from 'react'
import { toast } from 'sonner'
import type { TaskBasedSettings, GenerationTask } from '../../types/task-based-settings'
import { Button } from '@/components/ui/button'
import { Section } from '../common/Section'
import { CredentialsNotice } from './CredentialsNotice'
import { CIDRListManager } from './CIDRListManager'
import { TaskEditor } from './TaskEditor'
import { deleteGenerationTaskAction } from '../../actions'

interface TaskBasedConfigFormProps {
    initialSettings: Partial<TaskBasedSettings>
    onSave: (settings: Partial<TaskBasedSettings>) => Promise<{ success: boolean; message?: string; error?: string }>
}

export function TaskBasedConfigForm({ initialSettings, onSave }: TaskBasedConfigFormProps) {
    const [formData, setFormData] = useState<Partial<TaskBasedSettings>>({
        namedCIDRLists: initialSettings.namedCIDRLists || [],
        generationTasks: initialSettings.generationTasks || [],
    })

    const [newTaskId, setNewTaskId] = useState<string | null>(null)

    const handleSaveTask = (updatedTask: GenerationTask) => {
        // Update local state if needed (though it's already saved to KV)
        setFormData(prev => ({
            ...prev,
            generationTasks: (prev.generationTasks || []).map(t => t.id === updatedTask.id ? updatedTask : t)
        }))
        if (updatedTask.id === newTaskId) {
            setNewTaskId(null)
        }
    }

    const addNewTask = () => {
        const id = `task-${Date.now()}`
        const newTask: GenerationTask = {
            id,
            name: 'New Task',
            description: '',
            enabled: true,
            machineSelector: {
                field: 'tag',
                pattern: 'tag:',
            },
            recordTemplates: [
                {
                    recordType: 'A',
                    name: '{{machineName}}.example.com',
                    value: '{{tailscaleIP}}',
                    ttl: 3600,
                    proxied: false,
                },
            ],
        }

        setFormData({
            ...formData,
            generationTasks: [...(formData.generationTasks || []), newTask],
        })
        setNewTaskId(id)
    }


    const deleteTask = async (index: number) => {
        const tasks = formData.generationTasks || []
        const task = tasks[index]
        if (!task) return

        if (confirm(`Are you sure you want to delete the task "${task.name}"?`)) {
            // If it's a new unsaved task, just remove from state
            if (task.id === newTaskId) {
                setFormData({
                    ...formData,
                    generationTasks: tasks.filter((_, i) => i !== index),
                })
                setNewTaskId(null)
                return
            }

            try {
                const result = await deleteGenerationTaskAction(task.id)
                if (result.success) {
                    setFormData({
                        ...formData,
                        generationTasks: tasks.filter((_, i) => i !== index),
                    })
                    toast.success(`Task "${task.name}" deleted successfully`)
                } else {
                    toast.error(result.error || 'Failed to delete task')
                }
            } catch (error) {
                toast.error(error instanceof Error ? error.message : 'An error occurred')
            }
        }
    }

    return (
        <div className="max-w-5xl mx-auto p-6 space-y-6">
            <CredentialsNotice />

            <Section title="CIDR Lists">
                <CIDRListManager
                    cidrLists={formData.namedCIDRLists || []}
                    generationTasks={formData.generationTasks || []}
                    onChange={(lists) => setFormData({ ...formData, namedCIDRLists: lists })}
                />
            </Section>

            <Section
                title="Generation Tasks"
                description="Define how DNS records are generated based on machine selectors and templates."
                headerAction={
                    <Button type="button" onClick={addNewTask} size="sm">
                        + Add Generation Task
                    </Button>
                }
            >
                {(formData.generationTasks || []).length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                        <p>No generation tasks defined. Click "Add Generation Task" to create one.</p>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {formData.generationTasks?.map((task, index) => (
                            <TaskEditor
                                key={task.id}
                                task={task}
                                onSave={handleSaveTask}
                                onDelete={() => deleteTask(index)}
                                cidrLists={formData.namedCIDRLists || []}
                                isNew={task.id === newTaskId}
                            />
                        ))}
                    </div>
                )}
            </Section>

        </div>
    )
}
