import type { DesktopAppPlatform } from "@/runtime/desktop-app-platform";

export function getDesktopAppDownloadActionKey(
  platform: DesktopAppPlatform,
): "actions.downloadMacOSApp" | "actions.downloadWindowsApp" {
  return platform === "windows"
    ? "actions.downloadWindowsApp"
    : "actions.downloadMacOSApp";
}
