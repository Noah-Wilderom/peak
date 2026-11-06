import { useState } from "react"
import { RotateCwIcon, SquareIcon, UnplugIcon, ZapIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { monitor, type Proc, type TargetState } from "@/lib/monitor"

const report = (what: string) => (e: unknown) => toast.error(what, { description: String(e) })

/**
 * Actions for a run on another target. What's offered follows what's true: a
 * command peak launched can be stopped and rerun; an existing service can only be
 * detached from, unless someone deliberately chooses to signal it.
 */
export function TargetActions({ proc, target, linked }: { proc: Proc; target?: TargetState; linked: boolean }) {
  const [signalling, setSignalling] = useState(false)
  const running = proc.status === "running"
  const launched = proc.target!.launched
  const canSignal = linked && !!target?.capabilities.signal

  if (!running) {
    return launched ? (
      <Button variant="outline" disabled={!linked} title={linked ? undefined : "Not connected to this target"} onClick={() => monitor.restart(proc.id)}>
        <RotateCwIcon data-icon="inline-start" />
        Run again
      </Button>
    ) : null
  }

  return (
    <>
      <Button variant="outline" onClick={() => void monitor.detach(proc.id).catch(report("Couldn't detach"))} title="Stop watching. The process keeps running.">
        <UnplugIcon data-icon="inline-start" />
        Detach
      </Button>
      {launched && (
        <Button disabled={!linked} title={linked ? undefined : "Not connected to this target"} onClick={() => monitor.kill(proc.id)}>
          <SquareIcon data-icon="inline-start" className="fill-current" />
          Stop
        </Button>
      )}
      {!launched &&
        (signalling ? (
          <span className="flex items-center gap-1" role="group" aria-label={`Send a signal to PID ${proc.pid} on ${proc.target!.label}`}>
            {["TERM", "INT", "KILL"].map((s) => (
              <Button
                key={s}
                size="sm"
                variant="destructive"
                onClick={() => {
                  setSignalling(false)
                  void monitor.signal(proc.id, s).catch(report("Couldn't send the signal"))
                }}
              >
                {s}
              </Button>
            ))}
            <Button size="sm" variant="secondary" onClick={() => setSignalling(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button variant="outline" disabled={!canSignal} title={canSignal ? "Peak didn't start this process. Signalling it is your decision." : "Not connected to this target"} onClick={() => setSignalling(true)}>
            <ZapIcon data-icon="inline-start" />
            Signal…
          </Button>
        ))}
    </>
  )
}
