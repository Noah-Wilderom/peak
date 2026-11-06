import { describe, expect, it } from "vitest"
import {
  byteBreakdown,
  formatBytes,
  formatClock,
  formatCount,
  formatDuration,
  formatMs,
  formatOffset,
  formatPercent,
  formatRate,
} from "@/lib/format"

describe("format", () => {
  it("formats bytes with 1024 steps and trims zeros", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(-5)).toBe("0 B")
    expect(formatBytes(Number.NaN)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    // Regression: tweening a rate down to zero passes through fractions of a byte.
    expect(formatBytes(0.4)).toBe("0 B")
    expect(formatRate(0.7)).toBe("1 B/s")
    expect(formatBytes(1536)).toBe("1.5 KiB")
    expect(formatBytes(2 * 1024 ** 2)).toBe("2 MiB")
    expect(formatBytes(150 * 1024 ** 2)).toBe("150 MiB")
    expect(formatBytes(1.25 * 1024 ** 3, 2)).toBe("1.25 GiB")
    expect(formatBytes(1024 ** 6)).toBe("1048576 TiB")
    expect(formatRate(2048)).toBe("2 KiB/s")
  })

  it("formats durations and offsets", () => {
    expect(formatDuration(-1)).toBe("0s")
    expect(formatDuration(42_000)).toBe("42s")
    expect(formatDuration(65_000)).toBe("1m 05s")
    expect(formatDuration(3 * 3600_000 + 7 * 60_000)).toBe("3h 07m")
    expect(formatOffset(84_000)).toBe("1:24")
    expect(formatOffset(-5)).toBe("0:00")
    expect(formatOffset(84_500, true)).toBe("1:24.5")
    expect(formatOffset(59_960, true)).toBe("1:00.0")
    expect(formatOffset(-5, true)).toBe("0:00.0")
  })

  it("breaks bytes down into every unit", () => {
    const b = byteBreakdown(1536 * 1024)
    expect(b.bytes).toBe("1,572,864")
    expect(b.binary).toEqual([["KiB", "1,536"], ["MiB", "1.5"], ["GiB", "0.001465"]])
    expect(b.decimal).toEqual([["KB", "1,572.9"], ["MB", "1.573"], ["GB", "0.001573"]])
    expect(byteBreakdown(-5).bytes).toBe("0")
  })

  it("formats clock, percent, counts and milliseconds", () => {
    expect(formatClock(new Date(2026, 0, 1, 9, 5, 7).getTime())).toBe("09:05:07")
    expect(formatClock(new Date(2026, 0, 1, 9, 5, 7, 500).getTime(), true)).toBe("09:05:07.5")
    expect(formatPercent(12.345)).toBe("12.3%")
    expect(formatPercent(250)).toBe("250%")
    expect(formatCount(950)).toBe("950")
    expect(formatCount(12_345)).toBe("12.3k")
    expect(formatCount(2_500_000)).toBe("2.5M")
    expect(formatCount(3e9)).toBe("3B")
    expect(formatMs(0.123)).toBe("0.12ms")
    expect(formatMs(42.4)).toBe("42ms")
    expect(formatMs(1500)).toBe("1.5s")
    expect(formatMs(90_000)).toBe("1m 30s")
  })
})
