'use client'

import { useState, useMemo } from 'react'
import type { MachineSelector } from '../../types/task-based-settings'
import type { TailscaleDevice } from '../../types/tailscale'
import { getSupportedFields, selectMachines } from '../../utils/machine-selector'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { Check, ChevronsUpDown, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface MachineSelectorInputProps {
	selector: MachineSelector
	onChange: (selector: MachineSelector) => void
	devices?: TailscaleDevice[] // For live preview and autocomplete
}

export function MachineSelectorInput({ selector, onChange, devices = [] }: MachineSelectorInputProps) {
	const [open, setOpen] = useState(false)
	const supportedFields = getSupportedFields()

	// Calculate matched devices
	const matchedDevices = useMemo(() => {
		if (!devices.length) return []
		return selectMachines(devices, selector)
	}, [devices, selector])

	const isRegexPattern = selector.pattern.startsWith('/') && selector.pattern.endsWith('/')
	const selectedField = supportedFields.find((f) => f.value === selector.field)

	const suggestions = useMemo(() => {
		if (!selectedField || selectedField.type !== 'autocomplete' || !selectedField.getUniqueValues) {
			return []
		}
		return selectedField.getUniqueValues(devices)
	}, [selectedField, devices])

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
					<div className="flex justify-between">
						<Label htmlFor="selector-pattern">
							Pattern
							<span className="block text-xs text-muted-foreground font-normal mt-1">
								Exact match or regex (wrap in /.../)
							</span>
						</Label>
						{isRegexPattern && (
							<Badge variant="outline" className="h-5 text-[10px] px-1 bg-blue-50 text-blue-700 border-blue-200">
								Regex
							</Badge>
						)}
					</div>

					{selectedField?.type === 'autocomplete' ? (
						<Popover open={open} onOpenChange={setOpen}>
							<PopoverTrigger asChild>
								<Button
									variant="outline"
									role="combobox"
									aria-expanded={open}
									className="w-full justify-between font-normal"
								>
									{selector.pattern || 'Select value or type...'}
									<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
								</Button>
							</PopoverTrigger>
							<PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
								<Command>
									<CommandInput
										placeholder={`Search ${selectedField.label.toLowerCase()}...`}
										value={selector.pattern}
										onValueChange={(val) => onChange({ ...selector, pattern: val })}
									/>
									<CommandList>
										<CommandEmpty className="py-2 px-4 text-sm text-muted-foreground">
											<p>No existing value found.</p>
											<p className="text-xs mt-1">Type custom value or regex above.</p>
										</CommandEmpty>
										<CommandGroup heading="Existing Values">
											{suggestions.map((value) => (
												<CommandItem
													key={value}
													value={value}
													onSelect={(currentValue) => {
														onChange({ ...selector, pattern: currentValue })
														setOpen(false)
													}}
												>
													<Check
														className={cn(
															'mr-2 h-4 w-4',
															selector.pattern === value ? 'opacity-100' : 'opacity-0'
														)}
													/>
													{value}
												</CommandItem>
											))}
										</CommandGroup>
									</CommandList>
								</Command>
							</PopoverContent>
						</Popover>
					) : (
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
					)}

					{isRegexPattern && (
						<div className="flex gap-2 p-2 bg-blue-50/50 dark:bg-blue-950/20 rounded-md">
							<Info className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
							<p className="text-xs text-blue-900 dark:text-blue-100">
								Using regex mode. You can use named captures like{' '}
								<code className="bg-background px-1 py-0.5 rounded border">{'(?<env>prod|staging)'}</code> to
								extract values for templates.
							</p>
						</div>
					)}
				</div>
			</div>

			{devices.length > 0 && (
				<>
					<Separator />
					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<span className="text-sm font-medium">Live Preview</span>
							<Badge variant={matchedDevices.length > 0 ? "default" : "secondary"} className="text-xs">
								{matchedDevices.length} devices matched
							</Badge>
						</div>

						{matchedDevices.length > 0 ? (
							<div className="rounded-md border bg-background text-sm">
								<ul className="divide-y max-h-40 overflow-y-auto">
									{matchedDevices.slice(0, 5).map((match) => (
										<li key={match.device.id} className="p-2 flex items-center justify-between">
											<div className="flex flex-col">
												<span className="font-medium">{match.device.hostname}</span>
												<span className="text-xs text-muted-foreground">{match.device.name}</span>
											</div>
											<div className="flex gap-1">
												{match.device.tags?.slice(0, 2).map((tag) => (
													<Badge key={tag} variant="outline" className="text-[10px] h-4 px-1">
														{tag.replace('tag:', '')}
													</Badge>
												))}
												{(match.device.tags?.length || 0) > 2 && (
													<Badge variant="outline" className="text-[10px] h-4 px-1">
														+{(match.device.tags?.length || 0) - 2}
													</Badge>
												)}
											</div>
										</li>
									))}
								</ul>
								{matchedDevices.length > 5 && (
									<div className="p-2 text-xs text-center text-muted-foreground bg-muted/20 border-t">
										...and {matchedDevices.length - 5} more
									</div>
								)}
							</div>
						) : (
							<div className="p-3 bg-background border border-dashed rounded-md text-center text-sm text-muted-foreground">
								No devices match this selector
							</div>
						)}
					</div>
				</>
			)}
		</div>
	)
}
