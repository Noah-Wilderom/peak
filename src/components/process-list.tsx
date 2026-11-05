import { useMemo, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { MonitorIcon, MoonIcon, PlusIcon, SearchIcon, SunIcon } from "lucide-react"
import { Segmented } from "@/components/segmented"
import { useTheme } from "@/hooks/use-theme"
import { theme, type ThemeChoice } from "@/lib/theme"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sparkline } from "@/components/charts/sparkline"
import { StatusDot } from "@/components/status"
import { monitor, type Proc } from "@/lib/monitor"
import { viewData } from "@/lib/series"
import { formatBytes, formatDuration } from "@/lib/format"
import { cn } from "@/lib/utils"

interface ProcessListProps {
  procs: Proc[]
  selectedId: string | null
  capturing: boolean
  onCapture: () => void
  onSelect: (id: string) => void
}

export function ProcessList({ procs, selectedId, capturing, onCapture, onSelect }: ProcessListProps) {
  const [query, setQuery] = useState("")
  const { choice: themeChoice } = useTheme()
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return procs
    return procs.filter(
      (p) => p.command.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q) || String(p.pid).includes(q),
    )
  }, [procs, query])

  const running = filtered.filter((p) => p.status === "running")
  const ended = filtered.filter((p) => p.status !== "running")

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-border bg-background">
      <div className="flex items-center justify-between px-5 pt-5 pb-4">
        <div className="flex items-center gap-2.5">
          <Logo />
          <span className="text-title tracking-normal">peak.</span>
        </div>
        <Button size="sm" variant={capturing ? "secondary" : "default"} onClick={onCapture}>
          <PlusIcon data-icon="inline-start" />
          Capture
        </Button>
      </div>

      <div className="px-4 pb-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter processes"
            className="h-9 pl-10"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-4">
        <Section title="Running" count={running.length}>
          {running.map((p) => (
            <Row key={p.id} proc={p} active={p.id === selectedId} onSelect={onSelect} />
          ))}
          {running.length === 0 && <p className="px-3 py-2 text-xs text-faint">Nothing running.</p>}
        </Section>

        {ended.length > 0 && (
          <Section
            title="Ended"
            count={ended.length}
            action={
              <button
                onClick={monitor.clearEnded}
                className="rounded-full px-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            }
          >
            {ended.map((p) => (
              <Row key={p.id} proc={p} active={p.id === selectedId} onSelect={onSelect} />
            ))}
          </Section>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border px-5 py-3">
        <span className="text-xs font-semibold text-muted-foreground">Theme</span>
        <Segmented<ThemeChoice>
          size="sm"
          value={themeChoice}
          onChange={theme.set}
          options={[
            { value: "light", label: <SunIcon className="size-3.5" />, aria: "Light theme" },
            { value: "dark", label: <MoonIcon className="size-3.5" />, aria: "Dark theme" },
            { value: "system", label: <MonitorIcon className="size-3.5" />, aria: "System theme" },
          ]}
        />
      </div>
    </aside>
  )
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string
  count: number
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="mb-3">
      <div className="flex h-8 items-center justify-between px-3">
        <span className="text-xs font-semibold text-muted-foreground">
          {title} <span className="text-faint tabular-nums">{count}</span>
        </span>
        {action}
      </div>
      <ul className="flex flex-col gap-0.5">
        <AnimatePresence initial={false}>{children}</AnimatePresence>
      </ul>
    </div>
  )
}

function Row({ proc, active, onSelect }: { proc: Proc; active: boolean; onSelect: (id: string) => void }) {
  const last = proc.samples.at(-1)!
  const spark = useMemo(() => viewData(proc, { kind: "live", range: proc.status === "running" ? "1m" : "all" }).data, [proc])
  const running = proc.status === "running"
  const elapsed = (proc.endedAt ?? last.t) - proc.startedAt

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
    >
      <button
        onClick={() => onSelect(proc.id)}
        className={cn(
          "relative flex w-full flex-col gap-1.5 rounded-2xl px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-foreground",
          !active && "hover:bg-secondary/60",
        )}
      >
        {active && (
          <motion.span
            layoutId="row-active"
            className="absolute inset-0 rounded-2xl bg-secondary"
            transition={{ type: "spring", duration: 0.35, bounce: 0.12 }}
          />
        )}
        <span className="relative flex items-center gap-2.5">
          <StatusDot status={proc.status} />
          <span className={cn("flex-1 truncate font-mono text-[12.5px] font-medium", !running && "text-muted-foreground")}>
            {proc.command}
          </span>
        </span>
        <span className="relative flex items-center justify-between gap-2 pl-[18px]">
          <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
            {running ? formatBytes(last.rss) : `peak ${formatBytes(proc.peak.rss)}`}
            <span className="text-faint"> · {formatDuration(elapsed)}</span>
          </span>
          <Sparkline data={spark} muted={!running} />
        </span>
      </button>
    </motion.li>
  )
}

function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
      <rect width="24" height="24" rx="7.2" fill="var(--foreground)" />
      <path
        d="M5 16.5 9 12l3 2.5 5.5-7"
        fill="none"
        stroke="var(--background)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="17.5" cy="7.5" r="1.8" fill="var(--signal)" />
    </svg>
  )
}
