import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { toast } from "sonner"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ProcessList, type NavPage } from "@/components/process-list"
import { ProcessDetail } from "@/components/process-detail"
import { CapturePage } from "@/components/capture-page"
import { HistoryPage } from "@/components/history-page"
import { SettingsPage } from "@/components/settings-page"
import { ComparePage } from "@/components/compare-page"
import { MachinePage } from "@/components/machine-page"
import { TargetsPage } from "@/components/targets-page"
import { ErrorBoundary } from "@/components/error-boundary"
import { monitor } from "@/lib/monitor"
import { useMonitor, useMonitorEvents } from "@/hooks/use-monitor"
import type { MonitorEvent } from "@/lib/monitor"
import { formatBytes } from "@/lib/format"
import { nativeNotify } from "@/lib/notify"
import { UpdateNotice } from "@/components/update-panel"
import { updates } from "@/lib/updates"

/** Toast for every monitor event. */
export function notify(e: MonitorEvent) {
  const cmd = e.proc.command
  if (e.type === "captured") toast(`Capturing ${cmd}`, { description: `PID ${e.proc.pid}` })
  if (e.type === "exited") toast.success(`${cmd} finished`, { description: `Peak memory ${formatBytes(e.proc.peak.rss)}` })
  if (e.type === "crashed")
    toast.error(`${cmd} crashed`, {
      description: `${e.proc.signal ?? `exit ${e.proc.exitCode}`} · peak ${formatBytes(e.proc.peak.rss)}`,
    })
  if (e.type === "snapshot") toast("Heap snapshot captured", { description: formatBytes(e.snapshot.heapUsed) })
  if (e.type === "alert") {
    toast.warning(`Alert: ${cmd}`, { description: e.alert.message })
    if (e.notify) void nativeNotify(`Peak alert: ${cmd}`, e.alert.message)
  }
}

/** A full-page view shown instead of the selected process. */
type Page = NavPage | "capture" | { compare: [string, string] }

export default function App() {
  const { procs, selectedId, paused, system, ready, error, machine, targets } = useMonitor()
  const [page, setPage] = useState<Page | null>(null)
  const selected = procs.find((p) => p.id === selectedId) ?? null
  // With nothing selected, the capture page doubles as the empty state.
  const shown: Page | null = page ?? (selected ? null : "capture")
  const close = () => setPage(null)

  // A newly captured process takes over from the capture page. Other pages stay
  // put: pruning history can move the selection while Settings is open.
  useEffect(() => setPage((p) => (p === "capture" ? null : p)), [selectedId])

  useMonitorEvents(notify)

  useEffect(() => updates.start(), [])

  useEffect(() => {
    if (error) toast.error("Backend error", { description: error })
  }, [error])

  // ⌘K / Ctrl+K opens capture
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPage("capture")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const pageKey = typeof shown === "string" ? shown : shown ? "compare" : selected?.id

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full bg-background text-foreground">
        <ProcessList
          procs={procs}
          selectedId={shown ? null : selectedId}
          capturing={shown === "capture"}
          page={typeof shown === "string" && shown !== "capture" ? shown : null}
          onNavigate={setPage}
          machine={machine.at(-1)}
          targets={targets}
          onCapture={() => setPage("capture")}
          onSelect={(id) => {
            monitor.select(id)
            close()
          }}
        />
        <UpdateNotice />
        <main className="relative flex min-w-0 flex-1">
          <ErrorBoundary resetKey={pageKey}>
            <AnimatePresence mode="wait" initial={false}>
              {!ready ? null : shown === "capture" ? (
                <CapturePage key="capture" onClose={selected ? close : undefined} />
              ) : shown === "history" ? (
                <HistoryPage key="history" onClose={close} onOpened={close} onCompare={(a, b) => setPage({ compare: [a, b] })} />
              ) : shown === "settings" ? (
                <SettingsPage key="settings" onClose={close} />
              ) : shown === "targets" ? (
                <TargetsPage key="targets" targets={targets} onClose={close} />
              ) : shown === "machine" ? (
                <MachinePage key="machine" samples={machine} system={system} proc={selected} onClose={close} />
              ) : shown ? (
                <ComparePage key="compare" ids={shown.compare} onBack={() => setPage("history")} />
              ) : (
                <motion.div
                  key={selected!.id}
                  className="flex min-w-0 flex-1"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
                >
                  <ProcessDetail proc={selected!} paused={paused} system={system} targets={targets} />
                </motion.div>
              )}
            </AnimatePresence>
          </ErrorBoundary>
        </main>
      </div>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}
