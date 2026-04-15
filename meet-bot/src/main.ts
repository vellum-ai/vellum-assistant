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
 *   - If `MEET_URL` is set, brings up Xvfb + Chromium and navigates to the
 *     URL. When `JOIN_NAME` and `CONSENT_MESSAGE` are also set, runs the full
 *     Meet join flow (name entry, Join/Ask-to-join branch, consent notice)
 *     via `joinMeet`. When only `MEET_URL` is provided, drops a screenshot at
 *     `/tmp/boot-screenshot.png`, closes the session, and exits 0 — this is
 *     the browser-runtime smoke path the boot tests rely on.
 *   - On join failure, logs the error and exits with status 1 so the
 *     container orchestrator can observe the problem.
 *
 * Anything heavier — Hono HTTP control surface, live audio capture wiring,
 * transcript streaming — lands in later PRs.
 */

import { joinMeet } from "./browser/join-flow.js";
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
      const displayName = process.env.JOIN_NAME;
      const consentMessage = process.env.CONSENT_MESSAGE;

      if (displayName && consentMessage) {
        // Full join flow — drive the prejoin surface and post the consent
        // message. Failures abort with exit(1) so the container orchestrator
        // can restart or surface the error.
        try {
          await joinMeet(session.page, { displayName, consentMessage });
          console.log(`meet-bot joined ${meetUrl} as ${displayName}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`meet-bot: join flow failed: ${msg}`);
          process.exit(1);
        }
      } else {
        // Backward-compatible screenshot-only path — used by the boot smoke
        // test which sets only `MEET_URL`. Confirms the browser runtime can
        // reach Meet without actually entering a meeting.
        await session.page.screenshot({ path: "/tmp/boot-screenshot.png" });
        console.log(
          `meet-bot captured boot screenshot for ${meetUrl} at /tmp/boot-screenshot.png`,
        );
      }
    } finally {
      await session.close();
    }
  }
}

void main().catch((err) => {
  console.error("meet-bot failed:", err);
  process.exit(1);
});
