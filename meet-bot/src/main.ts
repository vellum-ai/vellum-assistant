/**
 * meet-bot entry point.
 *
 * This is the bootstrap for the Meet bot — the container-side process that
 * will join a Google Meet session on behalf of an AI assistant so the
 * assistant can listen in (and eventually participate).
 *
 * Current behavior:
 *
 *   - At boot we bring up the PulseAudio virtual devices (null-sinks + a
 *     virtual-source) so TTS can be routed into Chrome as a microphone and
 *     Chrome's output can be captured for STT. Pulse setup is skipped when
 *     `SKIP_PULSE=1` — the CI/local boot smoke test sets this so it can run
 *     on macOS developer machines where PulseAudio is unavailable.
 *   - Logs a boot marker so the boot smoke test and the Docker `CMD` can
 *     verify the package structure.
 *   - If `MEET_URL` is set, brings up Xvfb + Chromium, navigates to the URL,
 *     drops a screenshot at `/tmp/boot-screenshot.png`, closes the session,
 *     and exits 0. This is the browser-runtime smoke path; the real Meet
 *     join flow (lobby handling, name entry, join-button clicks) lands in
 *     PR 11 of the meet-phase-1 plan.
 *
 * Anything heavier — Hono HTTP control surface, live audio capture wiring,
 * transcript streaming — lands in later PRs.
 */

import { createBrowserSession } from "./browser/session.js";
import { setupPulseAudio } from "./media/pulse.js";

async function main(): Promise<void> {
  if (process.env.SKIP_PULSE !== "1") {
    try {
      await setupPulseAudio();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`meet-bot: PulseAudio setup failed: ${msg}`);
      process.exit(1);
    }
  }

  console.log("meet-bot booted");

  const meetUrl = process.env.MEET_URL;
  if (meetUrl) {
    const session = await createBrowserSession(meetUrl);
    try {
      await session.page.screenshot({ path: "/tmp/boot-screenshot.png" });
      console.log(
        `meet-bot captured boot screenshot for ${meetUrl} at /tmp/boot-screenshot.png`,
      );
    } finally {
      await session.close();
    }
  }
}

void main().catch((err) => {
  console.error("meet-bot failed:", err);
  process.exit(1);
});
