const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"]

export function formatBytes(bytes: number, digits = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  // Clamp both ends: sub-byte values (mid-tween towards 0) would give index -1.
  const i = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1))
  const value = bytes / 1024 ** i
  // parseFloat trims trailing zeros: 1.50 → 1.5, 2.0 → 2
  return `${parseFloat(value.toFixed(i === 0 || value >= 100 ? 0 : digits))} ${UNITS[i]}`
}

export function formatRate(bytesPerSec: number) {
  return `${formatBytes(bytesPerSec)}/s`
}

export function formatDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`
  if (m > 0) return `${m}m ${sec.toString().padStart(2, "0")}s`
  return `${sec}s`
}

/** Seconds relative to process start, e.g. "1:24". */
export function formatOffset(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`
}

export function formatClock(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

export function formatPercent(v: number) {
  return `${v.toFixed(v >= 100 ? 0 : 1)}%`
}

export function formatCount(v: number) {
  if (v >= 1e9) return `${parseFloat((v / 1e9).toFixed(1))}B`
  if (v >= 1e6) return `${parseFloat((v / 1e6).toFixed(1))}M`
  if (v >= 1e4) return `${parseFloat((v / 1e3).toFixed(1))}k`
  return Math.round(v).toLocaleString("en-US")
}

export function formatMs(ms: number) {
  if (ms >= 60_000) return formatDuration(ms)
  if (ms >= 1000) return `${parseFloat((ms / 1000).toFixed(2))}s`
  if (ms >= 10) return `${Math.round(ms)}ms`
  return `${parseFloat(ms.toFixed(2))}ms`
}

/** Every common unit for a byte count — binary (KiB…) and decimal (KB…). */
export function byteBreakdown(bytes: number) {
  const b = Math.max(0, bytes)
  const fmt = (v: number) =>
    v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 1 : v >= 1 ? 3 : 6 })
  return {
    bytes: Math.round(b).toLocaleString("en-US"),
    binary: [
      ["KiB", fmt(b / 1024)],
      ["MiB", fmt(b / 1024 ** 2)],
      ["GiB", fmt(b / 1024 ** 3)],
    ] as [string, string][],
    decimal: [
      ["KB", fmt(b / 1e3)],
      ["MB", fmt(b / 1e6)],
      ["GB", fmt(b / 1e9)],
    ] as [string, string][],
  }
}
