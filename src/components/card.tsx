import { cn } from "@/lib/utils"

export function Card({
  title,
  subtitle,
  action,
  className,
  children,
}: {
  title: string
  subtitle?: string
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={cn("rounded-card border border-border bg-background p-6", className)}>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
