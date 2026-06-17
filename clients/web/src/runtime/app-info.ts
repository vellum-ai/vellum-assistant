import { isElectron } from "@/runtime/is-electron";

/**
 * Per-capability wrapper for the Electron host's app-metadata bridge —
 * version, commit SHA, copyright, website. The renderer never touches
 * `window.vellum.*` directly; feature code calls these named functions
 * and the cross-platform branch lives here.
 *
 * Today the only consumer is the About page (`components/about-page.tsx`),
 * which only renders inside the Electron About BrowserWindow. The
 * wrapper still gates on `isElectron()` and returns a web-shaped
 * fallback so a misdirected web load doesn't crash.
 */

export interface AppVersionInfo {
  appName: string;
  version: string;
  commitSha: string;
  copyright: string;
  website: string;
}

export async function getAppVersionInfo(): Promise<AppVersionInfo | null> {
  if (!isElectron()) return null;
  return (await window.vellum?.app.versionInfo()) ?? null;
}

export async function openAppWebsite(): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.app.openWebsite();
}
