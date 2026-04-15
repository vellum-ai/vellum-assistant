/**
 * meet-bot entry point.
 *
 * This is the bootstrap for the Meet bot — the container-side process that
 * will join a Google Meet session on behalf of an AI assistant so the
 * assistant can listen in (and eventually participate).
 *
 * The real implementation (Playwright-driven Meet join flow, audio capture
 * via PulseAudio, Hono HTTP control surface, etc.) lands in later PRs of the
 * meet-phase-1 plan. See `meet-bot/README.md` for links.
 *
 * At boot we bring up the PulseAudio virtual devices (null-sinks + a
 * virtual-source) so TTS can be routed into Chrome as a microphone and
 * Chrome's output can be captured for STT. Pulse setup is skipped when
 * `SKIP_PULSE=1` — the CI/local boot smoke test sets this so it can run on
 * macOS developer machines where PulseAudio is unavailable.
 */

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
}

void main();
