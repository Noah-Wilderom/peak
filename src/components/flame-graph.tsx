import { useMemo, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { frameTotal, type AllocFrame } from "@/lib/types"
import { formatBytes } from "@/lib/format"
import { inkOn, inkRamp } from "@/lib/ramp"
import { useTheme } from "@/hooks/use-theme"
import { cn } from "@/lib/utils"

interface Cell {
  key: string
  /** Child-name path from the root; clicking a cell focuses this path. */
  path: string[]
  frame: AllocFrame
  depth: number
  x: number
  w: number
  total: number
}

const ROW = 26

/** A frame's identity among its siblings: same-named functions can live in different files. */
const frameId = (f: AllocFrame) => (f.file ? `${f.name}\u0000${f.file}` : f.name)

/** Lay frames out as an icicle chart (root on top), relative to `focus`. */
export function layoutFlame(root: AllocFrame, focusPath: string[]) {
  // Walk down to the focused frame; its ancestors render full-width above it.
  const ancestors: AllocFrame[] = []
  let focus = root
  for (const name of focusPath) {
    const next = focus.children.find((c) => frameId(c) === name)
    if (!next) break
    ancestors.push(focus)
    focus = next
  }
  const cells: Cell[] = []
  ancestors.forEach((a, depth) =>
    cells.push({ key: `a-${depth}`, path: focusPath.slice(0, depth), frame: a, depth, x: 0, w: 1, total: frameTotal(a) }),
  )
  const focusTotal = frameTotal(focus) || 1
  const visit = (f: AllocFrame, depth: number, x: number, path: string[]) => {
    const total = frameTotal(f)
    cells.push({ key: `f-${path.join("/")}`, path, frame: f, depth, x, w: total / focusTotal, total })
    let cx = x
    for (const c of [...f.children].sort((a, b) => frameTotal(b) - frameTotal(a))) {
      visit(c, depth + 1, cx, [...path, frameId(c)])
      cx += frameTotal(c) / focusTotal
    }
  }
  visit(focus, ancestors.length, 0, focusPath.slice(0, ancestors.length))
  return { cells, depth: Math.max(...cells.map((c) => c.depth)) + 1, focusTotal }
}

interface FlameGraphProps {
  root: AllocFrame
  /** How frame values read: bytes for allocation sites, time for CPU profiles. */
  format?: (value: number) => string
  hint?: string
}

export function FlameGraph({
  root,
  format = formatBytes,
  hint = "Width = bytes allocated beneath a frame. Stronger shade = more allocated in the frame itself. Click to zoom.",
}: FlameGraphProps) {
  const [focusPath, setFocusPath] = useState<string[]>([])
  const [hover, setHover] = useState<Cell | null>(null)
  const { dark } = useTheme()
  const { cells, depth } = useMemo(() => layoutFlame(root, focusPath), [root, focusPath])
  const rootTotal = frameTotal(root) || 1
  const maxSelf = Math.max(...cells.map((c) => c.frame.self / rootTotal), 1e-9)

  return (
    <div className="relative">
      <div className="relative w-full" style={{ height: depth * ROW }} onMouseLeave={() => setHover(null)}>
        {cells.map((c) => {
          const shade = 0.12 + 0.88 * (c.frame.self / rootTotal / maxSelf)
          return (
            <motion.button
              key={c.key}
              layout="position"
              initial={false}
              animate={{ left: `${c.x * 100}%`, width: `${c.w * 100}%` }}
              transition={{ duration: 0.35, ease: [0.25, 1, 0.5, 1] }}
              onMouseEnter={() => setHover(c)}
              onClick={() => setFocusPath(c.path)}
              className={cn(
                "absolute overflow-hidden rounded-md border-2 border-background px-2 text-left font-mono text-[11px] leading-[22px] whitespace-nowrap",
                hover?.key === c.key && "ring-2 ring-signal ring-inset",
              )}
              style={{ top: c.depth * ROW, height: ROW, background: inkRamp(shade, dark), color: inkOn(shade, dark) }}
            >
              {c.w > 0.04 ? c.frame.name : ""}
            </motion.button>
          )
        })}
      </div>
      <div className="mt-3 flex h-5 items-center justify-between text-xs text-muted-foreground">
        <AnimatePresence mode="wait">
          {hover ? (
            <motion.span key={hover.key} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="truncate">
              <span className="font-mono font-semibold text-foreground">{hover.frame.name}</span>
              {hover.frame.file && <span className="font-mono"> · {hover.frame.file}</span>}
              {" · "}
              {format(hover.total)} total ({((hover.total / rootTotal) * 100).toFixed(1)}%) · {format(hover.frame.self)} self
            </motion.span>
          ) : (
            <motion.span key="hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {hint}
            </motion.span>
          )}
        </AnimatePresence>
        {focusPath.length > 0 && (
          <button onClick={() => setFocusPath([])} className="shrink-0 font-semibold text-foreground hover:underline">
            Reset zoom
          </button>
        )}
      </div>
    </div>
  )
}
