import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let dark = false
const mqListeners = new Set<() => void>()
beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  dark = false
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        media: q,
        get matches() {
          return dark
        },
        addEventListener: (_: string, l: () => void) => mqListeners.add(l),
        removeEventListener: (_: string, l: () => void) => mqListeners.delete(l),
      }) as unknown as MediaQueryList,
  )
})
afterEach(() => document.documentElement.classList.remove("dark"))

describe("theme", () => {
  it("follows the system by default and reacts to OS changes", async () => {
    const { theme } = await import("@/lib/theme")
    const stop = theme.init()
    expect(theme.get()).toEqual({ choice: "system", dark: false })
    dark = true
    mqListeners.forEach((l) => l())
    expect(theme.get().dark).toBe(true)
    expect(document.documentElement).toHaveClass("dark")
    stop()
    expect(mqListeners.size).toBe(0)
  })

  it("persists explicit choices and notifies subscribers", async () => {
    const { theme } = await import("@/lib/theme")
    theme.init()
    const l = vi.fn()
    const off = theme.subscribe(l)
    theme.set("dark")
    expect(localStorage.getItem("peak-theme")).toBe("dark")
    expect(theme.get()).toEqual({ choice: "dark", dark: true })
    // OS changes are ignored while an explicit choice is set.
    dark = false
    mqListeners.forEach((fn) => fn())
    expect(theme.get().dark).toBe(true)
    theme.set("light")
    expect(theme.get().dark).toBe(false)
    theme.set("system")
    expect(localStorage.getItem("peak-theme")).toBeNull()
    expect(l).toHaveBeenCalledTimes(3)
    off()
  })

  it("restores a stored choice", async () => {
    localStorage.setItem("peak-theme", "dark")
    const { theme } = await import("@/lib/theme")
    expect(theme.get().choice).toBe("dark")
    localStorage.setItem("peak-theme", "light")
    theme.init()
    expect(theme.get()).toEqual({ choice: "light", dark: false })
  })
})
