import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Tween } from "@/components/tween"
import { byteBreakdown, formatBytes, formatRate } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * A byte value that eases between updates; hovering shows the exact count in
 * every unit, updating live while the card is open.
 */
export function Bytes({
  value,
  rate,
  className,
  children,
}: {
  value: number
  rate?: boolean
  className?: string
  /** Display override (defaults to the eased, formatted value). */
  children?: React.ReactNode
}) {
  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "cursor-help rounded-md decoration-faint decoration-dotted underline-offset-4 outline-none hover:underline focus-visible:underline",
            className,
          )}
        >
          {children ?? <Tween value={value} format={rate ? formatRate : formatBytes} />}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-60 rounded-2xl p-4">
        <ByteTable value={value} rate={rate} />
      </HoverCardContent>
    </HoverCard>
  )
}

export function ByteTable({ value, rate }: { value: number; rate?: boolean }) {
  const b = byteBreakdown(value)
  const unit = rate ? "/s" : ""
  return (
    <div className="grid gap-3 text-xs">
      <div>
        <p className="text-muted-foreground">Bytes{unit}</p>
        <p className="mt-0.5 font-mono text-[15px] font-semibold tabular-nums select-text">{b.bytes}</p>
      </div>
      <div className="grid grid-cols-2 gap-x-4 border-t border-border pt-3">
        {[b.binary, b.decimal].map((col, i) => (
          <dl key={i} className="grid gap-1.5">
            {col.map(([u, v]) => (
              <div key={u} className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">
                  {u}
                  {unit}
                </dt>
                <dd className="truncate font-mono tabular-nums select-text">{v}</dd>
              </div>
            ))}
          </dl>
        ))}
      </div>
    </div>
  )
}
