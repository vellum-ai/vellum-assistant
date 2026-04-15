/**
 * meet-bot entry point.
 *
 * This is the bootstrap skeleton for the Meet bot — the container-side process
 * that will join a Google Meet session on behalf of an AI assistant so the
 * assistant can listen in (and eventually participate).
 *
 * Current behavior:
 *
 *   - Logs a boot marker so the boot smoke test and the Docker `CMD` can
 *     verify the package structure.
 *   - If `MEET_URL` is set, brings up Xvfb + Chromium, navigates to the URL,
 *     drops a screenshot at `/tmp/boot-screenshot.png`, closes the session,
 *     and exits 0. This is the browser-runtime smoke path; the real Meet
 *     join flow (lobby handling, name entry, join-button clicks) lands in
 *     PR 11 of the meet-phase-1 plan.
 *
 * Anything heavier — Hono HTTP control surface, PulseAudio capture wiring,
 * transcript streaming — lands in later PRs.
 */

import { createBrowserSession } from "./browser/session.js";

async function main(): Promise<void> {
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
