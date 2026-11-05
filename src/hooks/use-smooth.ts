import { useEffect, useRef, useState } from "react"
import { animate } from "motion/react"
import { TICK_MS, type Proc } from "@/lib/types"
import { rangeMs, type View } from "@/lib/series"

// ─── shared animation clock ──────────────────────────────────────────────────
// One requestAnimationFrame loop for every chart; each subscriber is called at
// most once per `interval` ms, so long ranges don't re-render at 60fps.

type Sub = { interval: number; last: number; cb: (now: number) => void }
const subs = new Set<Sub>()
let raf = 0

function loop(ts: number) {
  const now = Date.now()
  subs.forEach((s) => {
    if (ts - s.last >= s.interval) {
      s.last = ts
      s.cb(now)
    }
  })
  raf = requestAnimationFrame(loop)
}

function useClock(enabled: boolean, interval: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const sub: Sub = { interval, last: 0, cb: setNow }
    subs.add(sub)
    if (!raf) raf = requestAnimationFrame(loop)
    return () => {
      subs.delete(sub)
      if (!subs.size) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }
  }, [enabled, interval])
  return now
}

/**
 * The visible [from, to] window. While live, the window glides continuously
 * with wall-clock time instead of jumping one sample at a time. It trails real
 * time by ~1.5 ticks so the newest sample is already loaded when it scrolls in.
 */
export function useTimeDomain(proc: Proc, view: View, paused: boolean): [number, number] {
  const span = rangeMs(proc, view)
  const lastT = proc.samples.at(-1)!.t
  const live = view.kind === "live" && proc.status === "running" && !paused
  // ~1px of movement per update on a ~1000px plot, between 60fps and 1fps.
  const interval = Math.min(1000, Math.max(16, span / 1000))
  const now = useClock(live, interval)

  if (view.kind === "fixed") return [view.from, view.to]
  const end = live ? Math.max(now - TICK_MS * 1.5, proc.samples[0].t) : lastT
  return [end - span, end]
}

/** Tween a number toward `target` (used for y-axis maxima, so axes ease instead of snapping). */
export function useTweened(target: number, duration = 0.6) {
  const [value, setValue] = useState(target)
  const current = useRef(target)
  useEffect(() => {
    const controls = animate(current.current, target, {
      duration,
      ease: [0.25, 1, 0.5, 1],
      onUpdate: (v) => {
        current.current = v
        setValue(v)
      },
    })
    return () => controls.stop()
  }, [target, duration])
  return value
}
