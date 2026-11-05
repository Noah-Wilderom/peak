import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach, vi } from "vitest"

afterEach(() => cleanup())

// jsdom lacks layout APIs that recharts / radix / motion reach for.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList
}

Element.prototype.scrollIntoView ??= vi.fn()
Element.prototype.hasPointerCapture ??= vi.fn(() => false)
Element.prototype.releasePointerCapture ??= vi.fn()

// Give elements a size so recharts' ResponsiveContainer actually renders.
const rect = { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 300, width: 800, height: 300, toJSON: () => ({}) }
const legend = { ...rect, right: 200, bottom: 20, width: 200, height: 20 }
Element.prototype.getBoundingClientRect = function (this: Element) {
  // Legends are a single short row; everything else gets the chart size.
  return (this.closest?.(".recharts-legend-wrapper") ? legend : rect) as DOMRect
}
for (const prop of ["clientWidth", "offsetWidth"] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 800 })
}
for (const prop of ["clientHeight", "offsetHeight"] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 300 })
}
