import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { toast } from "sonner"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ProcessList } from "@/components/process-list"
import { ProcessDetail } from "@/components/process-detail"
import { CapturePage } from "@/components/capture-page"
import { ErrorBoundary } from "@/components/error-boundary"
import { monitor } from "@/lib/monitor"
import { useMonitor, useMonitorEvents } from "@/hooks/use-monitor"
import type { MonitorEvent } from "@/lib/monitor"
import { formatBytes } from "@/lib/format"

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
}

export default function App() {
  const { procs, selectedId, paused, system, ready, error } = useMonitor()
  const [capturing, setCapturing] = useState(false)
  const selected = procs.find((p) => p.id === selectedId) ?? null
  const showCapture = capturing || !selected

  // A newly captured process takes over the main view.
  useEffect(() => setCapturing(false), [selectedId])

  useMonitorEvents(notify)

  useEffect(() => {
    if (error) toast.error("Backend error", { description: error })
  }, [error])

  // ⌘K / Ctrl+K opens capture
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setCapturing(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full bg-background text-foreground">
        <ProcessList
          procs={procs}
          selectedId={showCapture ? null : selectedId}
          capturing={showCapture}
          onCapture={() => setCapturing(true)}
          onSelect={(id) => {
            monitor.select(id)
            setCapturing(false)
          }}
        />
        <main className="relative flex min-w-0 flex-1">
          <ErrorBoundary resetKey={showCapture ? "capture" : selected?.id}>
            <AnimatePresence mode="wait" initial={false}>
              {!ready ? null : showCapture ? (
                <CapturePage key="capture" onClose={selected ? () => setCapturing(false) : undefined} />
              ) : (
                <motion.div
                  key={selected.id}
                  className="flex min-w-0 flex-1"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
                >
                  <ProcessDetail proc={selected} paused={paused} system={system} />
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
