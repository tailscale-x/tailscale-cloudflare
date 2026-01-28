'use client'

import { useState } from 'react'
import type { GenerationTask, NamedCIDRList, RecordTemplate } from '../../types/task-based-settings'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { TaskHeader } from './TaskHeader'
import { TaskForm } from './TaskForm'
import { RecordTemplateEditor } from './RecordTemplateEditor'
import { RecordPreview } from './RecordPreview'
import { toast } from 'sonner'
import { saveGenerationTaskAction } from '../../actions'
import { cn } from '@/lib/utils'

interface TaskEditorProps {
	task: GenerationTask
	onSave: (task: GenerationTask) => void
	onDelete: () => void
	cidrLists: NamedCIDRList[]
	isNew?: boolean
}

export function TaskEditor({ task: initialTask, onSave, onDelete, cidrLists, isNew }: TaskEditorProps) {
	const [task, setTask] = useState<GenerationTask>(initialTask)
	const [isExpanded, setIsExpanded] = useState(true)
	const [isSaving, setIsSaving] = useState(false)

	const handleSave = async () => {
		setIsSaving(true)
		try {
			const result = await saveGenerationTaskAction(task)
			if (result.success) {
				toast.success(`Task "${task.name}" ${isNew ? 'created' : 'saved'} successfully`)
				onSave(task)
			} else {
				toast.error(result.error || `Failed to ${isNew ? 'create' : 'save'} task`)
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'An error occurred')
		} finally {
			setIsSaving(false)
		}
	}

	const addRecordTemplate = () => {
		const newTemplate: RecordTemplate = {
			recordType: 'A',
			name: '{{machineName}}.example.com',
			value: '{{tailscaleIP}}',
			ttl: 3600,
			proxied: false,
		}

		setTask({
			...task,
			recordTemplates: [...task.recordTemplates, newTemplate],
		})
	}

	const updateRecordTemplate = (index: number, template: RecordTemplate) => {
		const newTemplates = [...task.recordTemplates]
		newTemplates[index] = template
		setTask({ ...task, recordTemplates: newTemplates })
	}

	const deleteRecordTemplate = (index: number) => {
		setTask({
			...task,
			recordTemplates: task.recordTemplates.filter((_, i) => i !== index),
		})
	}

	return (
		<Card className={cn('overflow-hidden transition-opacity', !task.enabled && 'opacity-60')}>
			<TaskHeader
				task={task}
				isExpanded={isExpanded}
				onToggleExpand={() => setIsExpanded(!isExpanded)}
				onDelete={onDelete}
			/>

			{isExpanded && (
				<div className="p-6 space-y-6">
					<TaskForm
						task={task}
						cidrLists={cidrLists}
						onUpdateName={(name) => setTask({ ...task, name })}
						onUpdateDescription={(description) => setTask({ ...task, description })}
						onUpdateSelector={(selector) => setTask({ ...task, machineSelector: selector })}
					/>

					<Separator />

					<div className="space-y-4">
						<div className="flex items-center justify-between">
							<h5 className="font-semibold">DNS Record Templates</h5>
							<Button type="button" onClick={addRecordTemplate} size="sm">
								+ Add Record Template
							</Button>
						</div>

						{task.recordTemplates.length === 0 ? (
							<div className="text-center py-8 text-muted-foreground bg-muted/50 rounded-lg border border-dashed">
								<p>No record templates defined. Click "Add Record Template" to create one.</p>
							</div>
						) : (
							<div className="space-y-3">
								{task.recordTemplates.map((template, index) => (
									<RecordTemplateEditor
										key={index}
										template={template}
										onChange={(t) => updateRecordTemplate(index, t)}
										onDelete={() => deleteRecordTemplate(index)}
										cidrLists={cidrLists}
									/>
								))}
							</div>
						)}

						<RecordPreview
							machineSelector={task.machineSelector}
							recordTemplates={task.recordTemplates}
						/>

						<div className="flex justify-end pt-4 border-t">
							<Button onClick={handleSave} disabled={isSaving}>
								{isSaving ? 'Saving...' : (isNew ? 'Create Task' : 'Save Task')}
							</Button>
						</div>
					</div>
				</div>
			)}
		</Card>
	)
}
