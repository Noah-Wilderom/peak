import { useId } from "react"
import { motion } from "motion/react"
import { cn } from "@/lib/utils"

interface SegmentedProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: React.ReactNode; aria?: string }[]
  className?: string
  size?: "sm" | "default"
}

/** Stadium track with a white pill that glides to the active option. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = "default",
}: SegmentedProps<T>) {
  const id = useId()
  return (
    <div
      role="radiogroup"
      className={cn(
        "inline-flex items-center rounded-full bg-secondary p-[3px]",
        size === "sm" ? "h-7" : "h-9",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            aria-label={o.aria}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative h-full rounded-full font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-foreground",
              size === "sm" ? "px-2.5 text-xs" : "px-3.5 text-sm",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-full bg-background shadow-[0_1px_2px_rgba(20,20,20,0.08)]"
                transition={{ type: "spring", duration: 0.35, bounce: 0.15 }}
              />
            )}
            <span className="relative">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
