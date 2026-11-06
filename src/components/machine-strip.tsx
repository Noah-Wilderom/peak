import type { SystemSample } from "@/lib/types"
import { formatBytes, formatPercent } from "@/lib/format"
import { cn } from "@/lib/utils"

/** The whole machine at a glance. Tells "my process is big" from "the box is starved". */
export function MachineStrip({ sample, active, onOpen }: { sample: SystemSample; active: boolean; onOpen: () => void }) {
  const used = Math.max(0, sample.memTotal - sample.memAvailable)
  const share = sample.memTotal > 0 ? used / sample.memTotal : 0
  const tight = share >= 0.9
  return (
    <button
      onClick={onOpen}
      aria-label="This machine: open details"
      className={cn(
        "mx-3 mb-1 rounded-2xl px-3 py-2.5 text-left outline-none hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-foreground",
        active && "bg-secondary",
      )}
    >
      <span className="flex items-center justify-between text-xs font-semibold text-muted-foreground">
        This machine
        <span className={cn("font-normal tabular-nums", tight && "font-semibold text-warning")}>
          {formatBytes(used)} of {formatBytes(sample.memTotal)}
        </span>
      </span>
      <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-secondary">
        <span className={cn("block h-full rounded-full", tight ? "bg-warning" : "bg-foreground")} style={{ width: `${share * 100}%` }} />
      </span>
      <span className="mt-1.5 flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>CPU {formatPercent(sample.cpu)}</span>
        <span>Load {sample.load1.toFixed(2)}</span>
      </span>
    </button>
  )
}
