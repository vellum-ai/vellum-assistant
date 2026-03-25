/**
 * Lightweight progress reporting for the desktop app.
 *
 * Writes structured `HATCH_PROGRESS:{...}` lines to stdout so the Electron
 * wrapper can parse them and render a progress bar during hatch.
 *
 * This module intentionally has ZERO internal imports to avoid circular
 * dependency issues — it is a leaf module.
 */

/**
 * Emit a structured progress event to stdout.
 *
 * Only emits when `VELLUM_DESKTOP_APP` env var is set (desktop mode).
 * The desktop app parses lines matching `HATCH_PROGRESS:{...}` to update
 * its progress UI.
 */
export function emitProgress(step: number, total: number, label: string): void {
  if (!process.env.VELLUM_DESKTOP_APP) return;
  const payload = JSON.stringify({ step, total, label });
  process.stdout.write(`HATCH_PROGRESS:${payload}\n`);
}
