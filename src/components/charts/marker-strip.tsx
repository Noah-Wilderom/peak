import { useTimeline } from "@/components/charts/timeline"
import { MARKER_STYLE, type Marker, type MarkerKind } from "@/lib/markers"
import { formatOffset } from "@/lib/format"

// The strip lines up with the memory chart's plot area (its left axis and right margin).
const PLOT_LEFT = 72
const PLOT_RIGHT = 20

/** Clickable, focusable events under the memory chart. Each opens the output at its time. */
export function MarkerStrip({ markers, from, to }: { markers: Marker[]; from: number; to: number }) {
  const { proc, onJump } = useTimeline()
  const span = Math.max(1, to - from)
  const kinds = (Object.keys(MARKER_STYLE) as MarkerKind[]).filter((k) => markers.some((m) => m.kind === k))

  return (
    <div className="mt-2">
      <div className="relative h-4" role="group" aria-label="Timeline events">
        {markers.map((m) => {
          const at = `T+${formatOffset(m.t - proc.startedAt)}`
          return (
            <button
              key={`${m.kind}-${m.t}`}
              onClick={() => onJump(m.t)}
              title={`${at} · ${m.label}`}
              aria-label={`${MARKER_STYLE[m.kind].name} at ${at}: ${m.label}. Open output.`}
              className="absolute top-0.5 size-3 -translate-x-1/2 rounded-full border-2 border-background outline-none hover:scale-125 focus-visible:ring-2 focus-visible:ring-foreground"
              style={{
                left: `calc(${PLOT_LEFT}px + (100% - ${PLOT_LEFT + PLOT_RIGHT}px) * ${(m.t - from) / span})`,
                background: MARKER_STYLE[m.kind].color,
              }}
            />
          )
        })}
      </div>
      {kinds.length > 0 && (
        <div className="mt-1 flex flex-wrap justify-end gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {kinds.map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: MARKER_STYLE[k].color }} />
              {MARKER_STYLE[k].name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
