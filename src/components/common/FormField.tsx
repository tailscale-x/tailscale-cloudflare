import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

interface FormFieldProps {
    label: string
    name: string
    value: string
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void
    type?: 'text' | 'password' | 'email'
    required?: boolean
    placeholder?: string
    helpText?: React.ReactNode
    multiline?: boolean
    rows?: number
    className?: string
}

export function FormField({
    label,
    name,
    value,
    onChange,
    type = 'text',
    required = false,
    placeholder,
    helpText,
    multiline = false,
    rows = 3,
    className,
}: FormFieldProps) {
    return (
        <div className={cn('space-y-2', className)}>
            <Label htmlFor={name}>
                {label}
                {required && <span className="text-destructive ml-1">*</span>}
            </Label>
            {multiline ? (
                <Textarea
                    id={name}
                    name={name}
                    value={value}
                    onChange={onChange}
                    required={required}
                    placeholder={placeholder}
                    rows={rows}
                />
            ) : (
                <Input
                    type={type}
                    id={name}
                    name={name}
                    value={value}
                    onChange={onChange}
                    required={required}
                    placeholder={placeholder}
                />
            )}
            {helpText && <p className="text-sm text-muted-foreground">{helpText}</p>}
        </div>
    )
}
