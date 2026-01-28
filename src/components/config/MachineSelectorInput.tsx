'use client'

import { useState, useEffect } from 'react'
import type { MachineSelector } from '../../types/task-based-settings'
import type { TailscaleDevice } from '../../types/tailscale'
import { getSupportedFields } from '../../utils/machine-selector'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

interface MachineSelectorInputProps {
	selector: MachineSelector
	onChange: (selector: MachineSelector) => void
	devices?: TailscaleDevice[] // For live preview
}

export function MachineSelectorInput({ selector, onChange, devices = [] }: MachineSelectorInputProps) {
	const [matchedCount, setMatchedCount] = useState<number>(0)
	const supportedFields = getSupportedFields()

	// Calculate matched devices count
	useEffect(() => {
		if (devices.length > 0) {
			// We'll need to import selectMachines for preview
			// For now, just show field selection
		}
	}, [selector, devices])

	const isRegexPattern = selector.pattern.startsWith('/') && selector.pattern.endsWith('/')
	const selectedField = supportedFields.find((f) => f.value === selector.field)

	return (
		<div className="border rounded-lg p-4 bg-muted/50 space-y-4">
			<div className="grid md:grid-cols-2 gap-4">
				<div className="space-y-2">
					<Label htmlFor="selector-field">
						Match Field
						<span className="block text-xs text-muted-foreground font-normal mt-1">
							Select which device property to match
						</span>
					</Label>
					<Select value={selector.field} onValueChange={(value) => onChange({ ...selector, field: value })}>
						<SelectTrigger id="selector-field">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{supportedFields.map((field) => (
								<SelectItem key={field.value} value={field.value}>
									{field.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{selectedField && (
						<p className="text-xs text-muted-foreground leading-relaxed">{selectedField.description}</p>
					)}
				</div>

				<div className="space-y-2">
					<Label htmlFor="selector-pattern">
						Pattern
						<span className="block text-xs text-muted-foreground font-normal mt-1">
							Exact match or regex (wrap in /.../ for regex)
						</span>
					</Label>
					<Input
						id="selector-pattern"
						type="text"
						value={selector.pattern}
						onChange={(e) => onChange({ ...selector, pattern: e.target.value })}
						placeholder={
							selector.field === 'tag'
								? 'tag:web or /^tag:(web|api)$/'
								: selector.field === 'name'
									? 'machine-name or /^prod-.*$/'
									: 'value or /pattern/'
						}
						className="font-mono"
					/>
					{isRegexPattern && (
						<div className="p-2 bg-blue-50 dark:bg-blue-950 rounded-md space-y-1">
							<Badge variant="default" className="text-xs">
								Regex Mode
							</Badge>
							<p className="text-xs text-blue-900 dark:text-blue-100">
								Tip: Use named captures like <code className="bg-white dark:bg-gray-800 px-1 py-0.5 rounded">{'(?<env>prod|staging)'}</code> to
								extract values for templates
							</p>
						</div>
					)}
				</div>
			</div>

			{devices.length > 0 && (
				<>
					<Separator />
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<span className="text-sm font-medium">Live Preview</span>
							<Badge variant="secondary" className="text-xs">
								{matchedCount} devices matched
							</Badge>
						</div>
						<div className="p-3 bg-background border border-dashed rounded-md text-center text-sm text-muted-foreground">
							Preview will show matching devices when selector logic is wired up
						</div>
					</div>
				</>
			)}
		</div>
	)
}
