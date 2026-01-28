'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface CIDRListFormProps {
    onAdd: (name: string) => void
    onCancel: () => void
}

export function CIDRListForm({ onAdd, onCancel }: CIDRListFormProps) {
    const [newListName, setNewListName] = useState('')

    const handleSubmit = () => {
        if (newListName.trim()) {
            onAdd(newListName.trim())
            setNewListName('')
        }
    }

    return (
        <div className="flex gap-2 p-4 bg-muted/50 rounded-lg mb-4">
            <Input
                type="text"
                placeholder="List name (e.g., home-lan, office-wan)"
                value={newListName}
                onChange={(e) => setNewListName(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSubmit()
                    if (e.key === 'Escape') {
                        onCancel()
                        setNewListName('')
                    }
                }}
                autoFocus
                className="flex-1"
            />
            <Button onClick={handleSubmit} size="sm">
                Create
            </Button>
            <Button onClick={onCancel} variant="outline" size="sm">
                Cancel
            </Button>
        </div>
    )
}
