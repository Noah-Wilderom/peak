import type { Attachable, HeapSnapshot, MonitorEvent, State } from "@/lib/types"

/** What the UI needs from a monitor — implemented by the mock and the Tauri backend. */
export interface MonitorApi {
  readonly mode: "mock" | "tauri"
  subscribe(listener: () => void): () => void
  getSnapshot(): State
  onEvent(listener: (e: MonitorEvent) => void): () => void

  select(id: string): void
  setPaused(paused: boolean): void
  capture(command: string, cwd: string): Promise<void>
  attach(pid: number): Promise<void>
  listAttachable(): Promise<Attachable[]>
  takeSnapshot(id: string): Promise<HeapSnapshot | null>
  forceGc(id: string): void
  kill(id: string): void
  restart(id: string): void
  remove(id: string): void
  clearEnded(): void
}
