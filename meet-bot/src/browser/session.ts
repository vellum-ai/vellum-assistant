/**
 * Browser session primitive for the meet-bot.
 *
 * `createBrowserSession(url)` brings up Xvfb (if not already running),
 * launches Playwright Chromium with the flags Google Meet expects from a
 * bot-tolerant browser, opens a page, navigates to `url`, and hands the
 * caller back `{ browser, context, page, close }`.
 *
 * Design notes:
 *
 *   - `headless: false` — we render into Xvfb instead. Meet's bot-detection
 *     is friendlier to a browser with a real display, and we need a window
 *     for getUserMedia permission UI to auto-accept via
 *     `--use-fake-ui-for-media-stream`.
 *   - `--use-fake-ui-for-media-stream` — auto-grants mic/camera without a
 *     permission prompt. Required for the Pulse-backed audio pipeline PR 5
 *     wires up.
 *   - `--no-sandbox` / `--disable-setuid-sandbox` — required inside the
 *     unprivileged Debian container; Chromium's sandbox needs capabilities
 *     we don't want to grant.
 *   - `--disable-dev-shm-usage` — `/dev/shm` in containers defaults to 64MB,
 *     which Chromium will overrun and crash. This flag moves the shared
 *     memory store to `/tmp`.
 *   - `PULSE_SOURCE=bot_mic` / `PULSE_SINK=meet_capture` — point Chromium at
 *     the virtual Pulse devices PR 5 provisions, so the bot's mic input
 *     comes from our TTS stream and the meeting's audio lands in a sink we
 *     can tap for transcription.
 *
 * Real Meet-join flow (lobby handling, name entry, participant waiting
 * logic) lands in PR 11 on top of this primitive.
 */

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

import type { XvfbHandle } from "./xvfb.js";
import { startXvfb } from "./xvfb.js";

export interface BrowserSessionOptions {
  /** Xvfb display to render into. Defaults to `":99"`. */
  xvfbDisplay?: string;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /**
   * Close the page, context, and browser in order. Tolerates already-closed
   * states — individual step failures are swallowed so `close` itself never
   * throws. Xvfb is intentionally *not* stopped here: higher-level callers
   * may reuse the same display for multiple sessions.
   */
  close: () => Promise<void>;
}

/** Chromium launch args used for every meet-bot browser session. */
export const CHROMIUM_ARGS: readonly string[] = [
  "--use-fake-ui-for-media-stream",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-setuid-sandbox",
  "--window-size=1280,720",
];

/**
 * Launch a Playwright Chromium browser pointed at `url` and return the
 * resulting session handle.
 *
 * Caller owns lifecycle: they must invoke `close()` when done. Xvfb is
 * started on demand (idempotent — `startXvfb` no-ops if the lock file
 * already exists), but left running past `close()` so the next session on
 * this process can reuse the display.
 */
export async function createBrowserSession(
  url: string,
  opts: BrowserSessionOptions = {},
): Promise<BrowserSession> {
  const display = opts.xvfbDisplay ?? ":99";

  // Fire-and-forget the lifetime of the Xvfb handle — we don't stop it when
  // the session closes (see docstring above). Keeping the reference local is
  // fine; process exit will tear it down.
  const xvfb: XvfbHandle = await startXvfb(display);
  void xvfb;

  const browser = await chromium.launch({
    headless: false,
    args: [...CHROMIUM_ARGS],
    env: {
      ...process.env,
      DISPLAY: display,
      PULSE_SOURCE: "bot_mic",
      PULSE_SINK: "meet_capture",
    },
  });

  let context: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    context = await browser.newContext();
    page = await context.newPage();
    // `load` is a reasonable default for Meet — `networkidle` never settles
    // for a live webapp with ongoing websocket/XHR traffic. PR 11 will
    // follow up with its own selector-based readiness waits.
    await page.goto(url, { waitUntil: "load" });
  } catch (err) {
    // Best-effort cleanup so we don't leak a running browser if navigation
    // (or context creation) blows up before we hand the session off.
    try {
      if (page) await page.close();
    } catch {
      // swallow
    }
    try {
      if (context) await context.close();
    } catch {
      // swallow
    }
    try {
      await browser.close();
    } catch {
      // swallow
    }
    throw err;
  }

  const close = async (): Promise<void> => {
    try {
      await page.close();
    } catch {
      // Page may already be closed (browser crash, manual close, etc.).
    }
    try {
      await context.close();
    } catch {
      // Ditto.
    }
    try {
      await browser.close();
    } catch {
      // Ditto.
    }
  };

  return { browser, context, page, close };
}
