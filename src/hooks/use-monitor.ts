import { useEffect, useSyncExternalStore } from "react"
import { monitor, type MonitorEvent } from "@/lib/monitor"

export function useMonitor() {
  return useSyncExternalStore(monitor.subscribe, monitor.getSnapshot)
}

export function useMonitorEvents(handler: (e: MonitorEvent) => void) {
  useEffect(() => monitor.onEvent(handler), [handler])
}
