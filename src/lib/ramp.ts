/**
 * Monochrome sequential ramp for "more = more ink": 0 → faint tint, 1 → full
 * ink. In dark mode ink is light, so the ramp runs dark → light.
 */
const LIGHT = { lo: [236, 236, 236], hi: [20, 20, 20] }
const DARK = { lo: [38, 38, 38], hi: [242, 242, 242] }

export function inkRamp(t: number, dark = false) {
  const x = Math.min(1, Math.max(0, t))
  const { lo, hi } = dark ? DARK : LIGHT
  const c = lo.map((v, i) => Math.round(v + (hi[i] - v) * x))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

/** Text colour that stays legible on top of `inkRamp(t, dark)`. */
export function inkOn(t: number, dark = false) {
  const strong = t > 0.45
  return strong !== dark ? "#ffffff" : "#141414"
}
