import { describe, expect, it } from "vitest"
import { inkOn, inkRamp } from "@/lib/ramp"
import { cn } from "@/lib/utils"
import { frameTotal } from "@/lib/types"

describe("ramp, cn, frameTotal", () => {
  it("interpolates the ink ramp and picks legible text", () => {
    expect(inkRamp(0)).toBe("rgb(236, 236, 236)")
    expect(inkRamp(1)).toBe("rgb(20, 20, 20)")
    expect(inkRamp(-1)).toBe(inkRamp(0))
    expect(inkRamp(2)).toBe(inkRamp(1))
    expect(inkOn(0.2)).toBe("#141414")
    expect(inkOn(0.9)).toBe("#ffffff")
    expect(inkRamp(0, true)).toBe("rgb(38, 38, 38)")
    expect(inkRamp(1, true)).toBe("rgb(242, 242, 242)")
    expect(inkOn(0.9, true)).toBe("#141414")
    expect(inkOn(0.2, true)).toBe("#ffffff")
  })

  it("merges class names", () => {
    expect(cn("px-2", "px-4", false && "hidden")).toBe("px-4")
  })

  it("sums allocation trees", () => {
    expect(frameTotal({ name: "r", self: 1, children: [{ name: "a", self: 2, children: [{ name: "b", self: 3, children: [] }] }] })).toBe(6)
  })
})
