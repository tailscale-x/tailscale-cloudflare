import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface SectionProps {
    title: string
    description?: string
    children: React.ReactNode
    className?: string
    headerAction?: React.ReactNode
}

export function Section({ title, description, children, className, headerAction }: SectionProps) {
    return (
        <Card className={cn('mb-6', className)}>
            <CardHeader>
                <div className="flex items-center justify-between">
                    <div className="flex-1">
                        <CardTitle>{title}</CardTitle>
                        {description && <CardDescription className="mt-1.5">{description}</CardDescription>}
                    </div>
                    {headerAction && <div className="ml-4">{headerAction}</div>}
                </div>
            </CardHeader>
            <CardContent>{children}</CardContent>
        </Card>
    )
}
