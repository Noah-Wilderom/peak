import { isTauri } from "@tauri-apps/api/core"

/** Words for the settings page: what happens if an alert tries to notify right now. */
export function notificationStatus() {
  // On Linux the plugin always reports permission as granted and can't see delivery failures.
  if (isTauri()) return "Handed to your desktop's notification service. Peak can't see whether it appears"
  if (typeof Notification === "undefined") return "Not supported here — alerts still show in the app"
  if (Notification.permission === "denied") return "Blocked by this browser — alerts still show in the app"
  return "Uses browser notifications"
}

async function viaTauri(title: string, body: string) {
  const plugin = await import("@tauri-apps/plugin-notification")
  const granted = (await plugin.isPermissionGranted()) || (await plugin.requestPermission()) === "granted"
  if (granted) plugin.sendNotification({ title, body })
  return granted
}

async function viaBrowser(title: string, body: string) {
  if (typeof Notification === "undefined") return false
  const granted = Notification.permission === "granted" || (await Notification.requestPermission()) === "granted"
  if (granted) new Notification(title, { body })
  return granted
}

/**
 * Best-effort desktop notification. Returns whether it was handed over, which isn't
 * proof it appeared. Never throws: a missing permission or service must not disturb
 * monitoring.
 */
export async function nativeNotify(title: string, body: string) {
  try {
    return await (isTauri() ? viaTauri(title, body) : viaBrowser(title, body))
  } catch {
    return false
  }
}
