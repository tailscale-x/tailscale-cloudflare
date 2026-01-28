'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import type { NamedCIDRList, GenerationTask } from '../../types/task-based-settings'
import { isCIDRListInUse, getCIDRListUsageCount } from '../../utils/cidr-list-manager'
import { Button } from '@/components/ui/button'
import { saveCIDRListAction, deleteCIDRListAction } from '../../actions'
import { CIDRListForm } from './CIDRListForm'
import { CIDRListItem } from './CIDRListItem'

interface CIDRListManagerProps {
	cidrLists: NamedCIDRList[]
	generationTasks: GenerationTask[]
	onChange: (lists: NamedCIDRList[]) => void
}

export function CIDRListManager({ cidrLists, generationTasks, onChange }: CIDRListManagerProps) {
	const [editingList, setEditingList] = useState<string | null>(null)
	const [showAddForm, setShowAddForm] = useState(false)

	const handleAddList = async (name: string) => {
		const newList: NamedCIDRList = {
			name,
			description: '',
			cidrs: ['192.168.0.0/16'],
			mode: 'multiple',
			inverse: false,
		}

		const result = await saveCIDRListAction(newList)
		if (result.success) {
			onChange([...cidrLists, newList])
			setShowAddForm(false)
			setEditingList(newList.name)
			toast.success(`CIDR list "${newList.name}" created successfully`)
		} else {
			toast.error(result.error || 'Failed to create CIDR list')
		}
	}

	const handleSaveList = async (listName: string) => {
		const list = cidrLists.find((l) => l.name === listName)
		if (!list) return

		const result = await saveCIDRListAction(list)
		if (result.success) {
			toast.success(`CIDR list "${list.name}" saved successfully`)
		} else {
			toast.error(result.error || 'Failed to save CIDR list')
		}
	}

	const handleUpdateCIDRs = (listName: string, cidrsText: string) => {
		const newCidrs = cidrsText
			.split(',')
			.map((c) => c.trim())
			.filter((c) => c.length > 0)

		const updatedLists = cidrLists.map((list) => (list.name === listName ? { ...list, cidrs: newCidrs } : list))

		onChange(updatedLists)
	}

	const handleUpdateDescription = (listName: string, description: string) => {
		const updatedLists = cidrLists.map((list) => (list.name === listName ? { ...list, description } : list))
		onChange(updatedLists)
	}

	const handleUpdateMode = (listName: string, mode: 'single' | 'multiple') => {
		const updatedLists = cidrLists.map((list) => (list.name === listName ? { ...list, mode } : list))
		onChange(updatedLists)
	}

	const handleUpdateInverse = (listName: string, inverse: boolean) => {
		const updatedLists = cidrLists.map((list) => (list.name === listName ? { ...list, inverse } : list))
		onChange(updatedLists)
	}

	const handleDeleteList = async (listName: string) => {
		if (isCIDRListInUse(listName, generationTasks)) {
			toast.error(`Cannot delete "${listName}" - it is being used by ${getCIDRListUsageCount(listName, generationTasks)} task(s)`)
			return
		}

		if (confirm(`Are you sure you want to delete the CIDR list "${listName}"?`)) {
			const result = await deleteCIDRListAction(listName)
			if (result.success) {
				onChange(cidrLists.filter((list) => list.name !== listName))
				toast.success(`CIDR list "${listName}" deleted successfully`)
			} else {
				toast.error(result.error || 'Failed to delete CIDR list')
			}
		}
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h3 className="text-lg font-semibold">Named CIDR Lists</h3>
				<Button type="button" onClick={() => setShowAddForm(true)} disabled={showAddForm} size="sm">
					+ Add CIDR List
				</Button>
			</div>

			{showAddForm && (
				<CIDRListForm
					onAdd={handleAddList}
					onCancel={() => setShowAddForm(false)}
				/>
			)}

			<div className="space-y-4">
				{cidrLists.length === 0 ? (
					<div className="text-center py-8 text-muted-foreground bg-muted/50 rounded-lg">
						<p>No CIDR lists defined. Create one to get started.</p>
					</div>
				) : (
					cidrLists.map((list) => (
						<CIDRListItem
							key={list.name}
							list={list}
							usageCount={getCIDRListUsageCount(list.name, generationTasks)}
							isEditing={editingList === list.name}
							onToggleEdit={() => {
								if (editingList === list.name) {
									setEditingList(null)
								} else {
									setEditingList(list.name)
								}
							}}
							onSave={() => {
								handleSaveList(list.name)
								setEditingList(null)
							}}
							onDelete={() => handleDeleteList(list.name)}
							onUpdateDescription={(desc) => handleUpdateDescription(list.name, desc)}
							onUpdateCIDRs={(cidrs) => handleUpdateCIDRs(list.name, cidrs)}
							onUpdateMode={(mode) => handleUpdateMode(list.name, mode)}
							onUpdateInverse={(inverse) => handleUpdateInverse(list.name, inverse)}
						/>
					))
				)}
			</div>
		</div>
	)
}
