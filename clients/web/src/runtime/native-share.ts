import { isElectron } from "@/runtime/is-electron";

/**
 * Per-capability wrapper for the Electron host's native Share Sheet. Matches
 * the pattern in `dock.ts` / `native-biometric.ts`: the renderer never touches
 * `window.vellum.*` directly — the cross-platform `saveFile` (native-file.ts)
 * calls this, and the platform branch lives here.
 *
 * On macOS this presents `NSSharingServicePicker` (Messages, Mail, AirDrop,
 * Slack, Save to Files, …) for the file, matching the native "export from the
 * app" UX the iOS build gets from `@capacitor/share`.
 *
 * The blob is supplied lazily (`resolveBlob`) and only awaited once the bridge
 * is confirmed present, so a URL-backed export doesn't fetch its bytes when the
 * host can't share and the caller is about to fall through to the browser
 * download (which would otherwise fetch the same URL a second time).
 *
 * Returns `true` when the share sheet was presented, and `false` when the host
 * can't offer it (non-Electron, or a preload too old to expose the bridge), so
 * the caller can fall through to the browser download.
 */
export async function shareFileViaMacSheet(
  resolveBlob: () => Promise<Blob>,
  filename: string,
): Promise<boolean> {
  if (!isElectron() || !window.vellum?.share) {
    return false;
  }
  const blob = await resolveBlob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await window.vellum.share.shareFile(bytes, filename);
  return true;
}
