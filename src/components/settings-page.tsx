import { useEffect, useState } from "react"
import { motion } from "motion/react"
import { DatabaseIcon, MonitorIcon, MoonIcon, SunIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/card"
import { Segmented } from "@/components/segmented"
import { useTheme } from "@/hooks/use-theme"
import { theme, type ThemeChoice } from "@/lib/theme"
import { monitor, type Settings, type StorageInfo } from "@/lib/monitor"
import { formatBytes, formatCount } from "@/lib/format"
import { nativeNotify, notificationStatus } from "@/lib/notify"

/** A whole number field value; anything else (including blank) counts as 0, meaning "off". */
function toCount(value: string) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const { choice } = useTheme()
  const [saved, setSaved] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [pruneDays, setPruneDays] = useState("30")
  const [confirmAll, setConfirmAll] = useState(false)
  const [busy, setBusy] = useState(false)

  const refreshStorage = async () => setStorage(await monitor.storageInfo())

  useEffect(() => {
    void Promise.all([monitor.getSettings(), monitor.storageInfo()])
      .then(([s, info]) => {
        setSaved(s)
        setDraft(s)
        setStorage(info)
      })
      .catch((e) => toast.error("Couldn't load settings", { description: String(e) }))
  }, [])

  const save = async (next: Settings) => {
    try {
      const stored = await monitor.setSettings(next)
      setSaved(stored)
      setDraft(stored)
      // Saving applies retention, which can remove runs.
      await refreshStorage()
      toast.success("Settings saved")
    } catch (e) {
      toast.error("Couldn't save settings", { description: String(e) })
    }
  }

  /** Run a maintenance action, report it, and show the new storage figures. */
  const maintain = async (action: () => Promise<string>) => {
    setBusy(true)
    try {
      toast.success(await action())
      await refreshStorage()
    } catch (e) {
      toast.error("Storage maintenance failed", { description: String(e) })
    } finally {
      setBusy(false)
      setConfirmAll(false)
    }
  }

  const sendTest = async () => {
    if (await nativeNotify("Peak", "Notifications are working.")) {
      toast("Test notification handed over", { description: "If nothing appeared, your desktop has no notification service running, or it's silenced." })
    } else {
      toast.error("Couldn't send a notification", { description: "Alerts will still show inside peak." })
    }
  }

  const removed = (n: number) => `Removed ${n} ${n === 1 ? "run" : "runs"}`
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved)
  const set = (patch: Partial<Settings>) => setDraft((d) => ({ ...d!, ...patch }))
  const permission = notificationStatus()

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
      className="flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-[900px] min-w-0 flex-col gap-4 px-10 pt-12 pb-10">
        <div className="mb-4 flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[44px] leading-[1.05] font-[650]">Settings.</h1>
            <p className="mt-3 max-w-xl text-[19px] leading-snug font-light text-muted-foreground">
              How long peak keeps history, when it should warn you, and how it looks.
            </p>
          </div>
          <Button variant="secondary" size="icon" onClick={onClose} aria-label="Close">
            <XIcon />
          </Button>
        </div>

        <Card title="Appearance.">
          <Row label="Theme">
            <Segmented<ThemeChoice>
              size="sm"
              value={choice}
              onChange={theme.set}
              options={[
                { value: "light", label: <SunIcon className="size-3.5" />, aria: "Light theme" },
                { value: "dark", label: <MoonIcon className="size-3.5" />, aria: "Dark theme" },
                { value: "system", label: <MonitorIcon className="size-3.5" />, aria: "System theme" },
              ]}
            />
          </Row>
        </Card>

        {draft && (
          <>
            <Card title="Retention." subtitle="Applied when you save, and every 10 minutes after. Running processes are never removed.">
              <Row label="Keep stopped runs for" hint="days · 0 keeps them forever">
                <NumberField label="Retention days" value={draft.retentionDays} onChange={(v) => set({ retentionDays: Math.floor(v) })} />
              </Row>
              <Row label="Keep at most" hint="stopped runs · 0 is unlimited">
                <NumberField label="Maximum runs" value={draft.maxRuns} onChange={(v) => set({ maxRuns: Math.floor(v) })} />
              </Row>
            </Card>

            <Card title="Alerts." subtitle="Checked against every process as it is sampled. An alert fires once per crossing.">
              <Row label="Alerts">
                <Toggle label="Alerts" value={draft.alertsEnabled} onChange={(alertsEnabled) => set({ alertsEnabled })} />
              </Row>
              <Row label="Memory above" hint="MiB resident · 0 is off">
                <NumberField label="Memory threshold in MiB" value={draft.alertMemoryMib} onChange={(alertMemoryMib) => set({ alertMemoryMib })} />
              </Row>
              <Row label="CPU above" hint="% · 100 is one full core">
                <NumberField label="CPU threshold in percent" value={draft.alertCpuPercent} onChange={(alertCpuPercent) => set({ alertCpuPercent })} />
              </Row>
              <Row label="…sustained for" hint="seconds · 0 is off">
                <NumberField label="CPU duration in seconds" value={draft.alertCpuSeconds} onChange={(alertCpuSeconds) => set({ alertCpuSeconds })} />
              </Row>
              <Row label="Desktop notifications" hint={permission}>
                <Toggle label="Desktop notifications" value={draft.notifications} onChange={(notifications) => set({ notifications })} />
              </Row>
              <Row label="Check notifications">
                <Button size="sm" variant="outline" onClick={() => void sendTest()}>
                  Send test
                </Button>
              </Row>
            </Card>

            <div className="flex items-center justify-end gap-3">
              {dirty && <span className="text-sm text-muted-foreground">Unsaved changes</span>}
              <Button variant="secondary" disabled={!dirty} onClick={() => setDraft(saved)}>
                Discard
              </Button>
              <Button disabled={!dirty} onClick={() => void save(draft)}>
                Save settings
              </Button>
            </div>
          </>
        )}

        {storage && (
          <Card title="Storage." subtitle="Maintenance only touches stopped runs. Running processes keep recording.">
            <dl className="divide-y divide-border">
              <Row label="Database">
                <span className="truncate font-mono text-xs select-text" title={storage.path}>{storage.path}</span>
              </Row>
              <Row label="Size on disk">
                <span className="text-sm tabular-nums">{formatBytes(storage.bytes)}</span>
              </Row>
              <Row label="Runs">
                <span className="text-sm tabular-nums">
                  {formatCount(storage.runs)} ({formatCount(storage.stoppedRuns)} stopped)
                </span>
              </Row>
              <Row label="Samples">
                <span className="text-sm tabular-nums">{formatCount(storage.samples)}</span>
              </Row>
            </dl>
            <div className="mt-5 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm">Delete stopped runs older than</span>
                <Input
                  aria-label="Prune age in days"
                  inputMode="numeric"
                  className="h-9 w-20"
                  value={pruneDays}
                  onChange={(e) => setPruneDays(e.target.value)}
                />
                <span className="text-sm text-muted-foreground">days</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    const days = Math.floor(toCount(pruneDays))
                    void maintain(async () => removed(await monitor.pruneRuns(days)))
                  }}
                >
                  Delete old runs
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {confirmAll ? (
                  <>
                    <span className="text-sm">
                      Delete all {formatCount(storage.stoppedRuns)} stopped runs? Running processes are not affected.
                    </span>
                    <Button size="sm" disabled={busy} onClick={() => void maintain(async () => removed(await monitor.pruneRuns()))}>
                      Delete all
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setConfirmAll(false)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmAll(true)}>
                    Delete all stopped runs
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void maintain(async () => {
                      await monitor.vacuum()
                      return "Database compacted"
                    })
                  }
                >
                  <DatabaseIcon data-icon="inline-start" />
                  Compact database
                </Button>
              </div>
            </div>
          </Card>
        )}
      </div>
    </motion.div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-6 py-1.5">
      <div className="min-w-0">
        <p className="text-sm">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex min-w-0 items-center justify-end">{children}</div>
    </div>
  )
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <Input
      aria-label={label}
      inputMode="decimal"
      className="h-9 w-24 text-right tabular-nums"
      value={value}
      onChange={(e) => onChange(toCount(e.target.value))}
    />
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Segmented<"on" | "off">
      size="sm"
      value={value ? "on" : "off"}
      onChange={(v) => onChange(v === "on")}
      options={[
        { value: "off", label: "Off", aria: `${label} off` },
        { value: "on", label: "On", aria: `${label} on` },
      ]}
    />
  )
}
