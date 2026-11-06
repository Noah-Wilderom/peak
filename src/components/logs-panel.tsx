import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ArrowDownIcon } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { Segmented } from "@/components/segmented"
import type { Proc } from "@/lib/types"
import { formatOffset } from "@/lib/format"
import { cn } from "@/lib/utils"

type Stream = "all" | "stdout" | "stderr"

/** A request to show the output around a moment in the run. */
export interface LogJump {
  t: number
  seq: number
}

/** Beyond this distance a line isn't really "the output at that time". */
const NEAR_MS = 5000

export function LogsPanel({ proc, jump }: { proc: Proc; jump?: LogJump | null }) {
  const [stream, setStream] = useState<Stream>("all")
  const [follow, setFollow] = useState(true)
  const [target, setTarget] = useState<{ t: number; id: number | null; near: boolean } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const lines = stream === "all" ? proc.logs : proc.logs.filter((l) => l.stream === stream)
  const errCount = proc.logs.filter((l) => l.stream === "stderr").length

  useLayoutEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines.length, follow])

  useEffect(() => setFollow(true), [proc.id])

  // Jump to the line closest in time. `proc.logs` is read once per request: new
  // output arriving later must not move the view.
  useEffect(() => {
    if (!jump) return
    let nearest: Proc["logs"][number] | null = null
    for (const l of proc.logs) {
      if (!nearest || Math.abs(l.t - jump.t) < Math.abs(nearest.t - jump.t)) nearest = l
    }
    setStream("all")
    setFollow(false)
    setTarget({ t: jump.t, id: nearest?.id ?? null, near: !!nearest && Math.abs(nearest.t - jump.t) <= NEAR_MS })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.seq])

  useLayoutEffect(() => {
    const el = target && ref.current?.querySelector<HTMLElement>(`[data-log="${target.id}"]`)
    if (el) ref.current!.scrollTop = el.offsetTop - 40
  }, [target])

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-card border border-border">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <Segmented
          size="sm"
          value={stream}
          onChange={setStream}
          options={[
            { value: "all", label: "All" },
            { value: "stdout", label: "stdout" },
            { value: "stderr", label: `stderr ${errCount}` },
          ]}
        />
        <span className="text-xs text-muted-foreground tabular-nums">{lines.length} lines</span>
      </div>
      {proc.target && !proc.target.launched && (
        <p className="border-b border-border bg-secondary px-5 py-2 text-xs text-muted-foreground">
          Peak attached to this process on {proc.target.label}, so its stdout and stderr aren't captured here.
          {proc.target.kind !== "ssh" && " Container logs are on the Targets page, labelled as such."}
        </p>
      )}
      {target && (
        <div className="flex items-center justify-between gap-4 border-b border-border bg-secondary px-5 py-2 text-xs">
          <span>
            {target.id === null
              ? "This run recorded no output."
              : target.near
                ? `Output at T+${formatOffset(target.t - proc.startedAt)}.`
                : `No output within 5s of T+${formatOffset(target.t - proc.startedAt)}; showing the nearest line.`}
          </span>
          <button onClick={() => setTarget(null)} className="shrink-0 font-semibold hover:underline">
            Clear
          </button>
        </div>
      )}
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
        }}
        className="flex-1 overflow-y-auto py-3 font-mono text-[12px] leading-[1.7] select-text"
      >
        {lines.map((l) => (
          <div key={l.id} data-log={l.id} className={cn("flex gap-4 px-5 hover:bg-secondary/60", l.id === target?.id && "bg-signal/10")}>
            <span className="w-12 shrink-0 text-right text-faint tabular-nums">{formatOffset(l.t - proc.startedAt)}</span>
            <span
              className={cn(
                "min-w-0 flex-1 break-words whitespace-pre-wrap",
                l.stream === "stderr" ? "text-danger" : "text-ink-soft",
              )}
            >
              {l.stream === "stderr" && (
                <span className="mr-2 rounded-full bg-danger/12 px-1.5 py-px text-[10px] font-semibold text-danger">err</span>
              )}
              {l.text}
            </span>
          </div>
        ))}
      </div>
      <AnimatePresence>
        {!follow && (
          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18 }}
            onClick={() => {
              setFollow(true)
              setTarget(null)
            }}
            className="absolute bottom-4 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full bg-foreground px-3.5 text-xs font-semibold text-background"
          >
            <ArrowDownIcon className="size-3.5" />
            Follow output
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}
