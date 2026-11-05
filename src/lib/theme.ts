/** Light / dark / follow-the-system theme, persisted in localStorage. */

export type ThemeChoice = "light" | "dark" | "system"
const KEY = "peak-theme"

type Listener = () => void
const listeners = new Set<Listener>()

function systemDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

function read(): ThemeChoice {
  const v = localStorage.getItem(KEY)
  return v === "light" || v === "dark" ? v : "system"
}

let choice: ThemeChoice = read()
let snapshot = { choice, dark: choice === "dark" || (choice === "system" && systemDark()) }

function apply() {
  snapshot = { choice, dark: choice === "dark" || (choice === "system" && systemDark()) }
  document.documentElement.classList.toggle("dark", snapshot.dark)
  listeners.forEach((l) => l())
}

export const theme = {
  get: () => snapshot,
  set(next: ThemeChoice) {
    choice = next
    if (next === "system") localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
    apply()
  },
  subscribe(l: Listener) {
    listeners.add(l)
    return () => void listeners.delete(l)
  },
  /** Apply the stored choice and follow OS changes while on "system". */
  init() {
    choice = read()
    apply()
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => choice === "system" && apply()
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  },
}
