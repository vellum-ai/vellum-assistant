/**
 * A remaining duration as `m:ss`, the countdown shape both pairing surfaces
 * render (the host's expiring pair code and the importing device's approval
 * code). Digits only, so no locale owns it; the sentence around it comes from
 * the catalogs. Floors at `0:00`, since a lapsed deadline is not negative time.
 */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Number.isFinite(remainingMs)
    ? Math.max(0, Math.ceil(remainingMs / 1000))
    : 0;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
