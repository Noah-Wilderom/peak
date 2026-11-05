import { isTauri } from "@tauri-apps/api/core"
import type { MonitorApi } from "@/lib/monitor-api"
import { MockMonitor } from "@/lib/mock"
import { TauriMonitor } from "@/lib/tauri-monitor"

export * from "@/lib/types"
export type { MonitorApi } from "@/lib/monitor-api"

/** Real backend inside the Tauri shell; simulated data in a plain browser. */
export const monitor: MonitorApi = isTauri() ? new TauriMonitor() : new MockMonitor()
