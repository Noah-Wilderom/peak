import { motion } from "motion/react"
import type { Proc } from "@/lib/types"
import { runOutcome } from "@/lib/history"
import { cn } from "@/lib/utils"

export function StatusDot({ status, className }: { status: Proc["status"]; className?: string }) {
  if (status === "running") {
    return (
      <span className={cn("relative inline-flex size-2", className)}>
        <motion.span
          className="absolute inset-0 rounded-full bg-success"
          animate={{ scale: [1, 2.2], opacity: [0.35, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
        />
        <span className="relative size-2 rounded-full bg-success" />
      </span>
    )
  }
  return (
    <span
      className={cn(
        "inline-flex size-2 rounded-full",
        status === "crashed" ? "bg-danger ring-2 ring-danger/20" : "border-[1.5px] border-faint",
        className,
      )}
    />
  )
}

export const statusLabel = runOutcome

export function StatusPill({ proc }: { proc: Proc }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-2 rounded-full px-2.5 text-label whitespace-nowrap",
        proc.status === "running" && "bg-success/12 text-success",
        proc.status === "crashed" && "bg-danger/12 text-danger",
        proc.status === "exited" && "bg-secondary text-muted-foreground",
      )}
    >
      <StatusDot status={proc.status} />
      {statusLabel(proc)}
    </span>
  )
}

const RUNTIME_GLYPH: Record<Proc["runtime"], string> = {
  node: "Js",
  bun: "Bn",
  python: "Py",
  rust: "Rs",
  go: "Go",
  shell: "Sh",
}

/** iOS-style 30% squircle tile — the design's signature icon motif. */
export function RuntimeTile({ runtime, size = 40 }: { runtime: Proc["runtime"]; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center bg-secondary font-mono font-semibold text-foreground"
      style={{ width: size, height: size, borderRadius: "30%", fontSize: size * 0.34 }}
    >
      {RUNTIME_GLYPH[runtime]}
    </span>
  )
}
