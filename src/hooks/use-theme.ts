import { useSyncExternalStore } from "react"
import { theme } from "@/lib/theme"

export function useTheme() {
  return useSyncExternalStore(theme.subscribe, theme.get)
}
