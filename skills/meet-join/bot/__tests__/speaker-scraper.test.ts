/**
 * Unit tests for the DOM active-speaker scraper.
 *
 * We don't spin up a real browser here — that's what `XVFB_TEST=1` style
 * integration tests are for. Instead we:
 *
 *   1. Build a jsdom document from the committed in-meeting fixture.
 *   2. Wrap it in a minimal Playwright-`Page`-shaped mock that redirects
 *      `evaluate` / `exposeFunction` into the jsdom window.
 *   3. Flip `data-active-speaker` attributes on the fixture tiles to
 *      simulate Meet promoting/demoting participants, and assert the
 *      scraper turns those transitions into `SpeakerChangeEvent`s.
 *
 * Every mutation in this file goes through jsdom's real MutationObserver,
 * so the test exercises the same in-page observer wiring that runs in
 * production.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

import {
  SpeakerChangeEventSchema,
  type SpeakerChangeEvent,
} from "../../contracts/index.js";

import {
  startSpeakerScraper,
  type ScraperPage,
} from "../src/browser/speaker-scraper.js";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "meet-dom-ingame.html");

interface JsdomPageHarness {
  page: ScraperPage;
  dom: JSDOM;
  /** Replace the current active-speaker tile by id; setting `null` clears. */
  setActiveSpeaker: (participantId: string | null) => void;
  /** Tear the fake page down — mirrors Playwright's `page.close()`. */
  close: () => void;
}

/**
 * Build a jsdom-backed `ScraperPage` seeded with the ingame fixture.
 *
 * The harness wires `evaluate` / `exposeFunction` into the jsdom window so
 * the scraper's in-page code executes against a real MutationObserver.
 * That means attribute flips on the fixture DOM actually trigger the
 * observer, which then invokes the exposed callback — the same flow the
 * production scraper takes against a live Playwright page.
 */
function makeJsdomPage(): JsdomPageHarness {
  const html = readFileSync(FIXTURE_PATH, "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const { window } = dom;
  let closed = false;

  // Install jsdom's window, document, and MutationObserver onto the Node
  // globalThis for the lifetime of this page. The real Playwright bridge
  // executes page functions inside the page's JS realm, which means the
  // MutationObserver's async callbacks always see the browser's globals.
  // Here we mimic that by keeping the globals live from start to close —
  // restoring them between `evaluate` calls would leave the async
  // callback's `document.querySelector` pointing at `undefined`.
  const previousGlobals = {
    window: (globalThis as { window?: unknown }).window,
    document: (globalThis as { document?: unknown }).document,
    MutationObserver: (globalThis as { MutationObserver?: unknown })
      .MutationObserver,
  };
  (globalThis as { window?: unknown }).window = window;
  (globalThis as { document?: unknown }).document = window.document;
  (globalThis as { MutationObserver?: unknown }).MutationObserver =
    window.MutationObserver;

  const page: ScraperPage = {
    /**
     * Mirror `Page.evaluate` by invoking the caller-supplied function in
     * the Node context with jsdom globals already installed on
     * `globalThis`. The globals stay live for the whole page lifetime so
     * async observer callbacks can still find them.
     */
    evaluate: (async (fn: unknown, arg: unknown) => {
      if (closed) throw new Error("page closed");
      // Accept both function refs and string expressions; the scraper
      // only uses function refs, so that's the only path we need.
      if (typeof fn !== "function") {
        throw new Error("string evaluate not supported by test harness");
      }
      return await (fn as (a: unknown) => unknown)(arg);
    }) as ScraperPage["evaluate"],

    /**
     * Mirror `Page.exposeFunction` by installing the callback on the
     * jsdom window under the given name. The in-page scraper code reads
     * it back through `window[name]`.
     */
    exposeFunction: (async (
      name: string,
      callback: (...args: unknown[]) => unknown,
    ) => {
      if (closed) throw new Error("page closed");
      (window as unknown as Record<string, unknown>)[name] = callback;
    }) as ScraperPage["exposeFunction"],

    isClosed: () => closed,
  };

  const setActiveSpeaker = (participantId: string | null): void => {
    const tiles = window.document.querySelectorAll("[data-participant-tile]");
    for (const tile of Array.from(tiles)) {
      const id = tile.getAttribute("data-participant-id");
      tile.setAttribute(
        "data-active-speaker",
        id === participantId ? "true" : "false",
      );
    }
  };

  return {
    page,
    dom,
    setActiveSpeaker,
    close: () => {
      closed = true;
      // Restore the pre-test globals so the next test (or unrelated
      // modules run by the test runner) sees a pristine environment.
      (globalThis as { window?: unknown }).window = previousGlobals.window;
      (globalThis as { document?: unknown }).document =
        previousGlobals.document;
      (globalThis as { MutationObserver?: unknown }).MutationObserver =
        previousGlobals.MutationObserver;
      dom.window.close();
    },
  };
}

/**
 * Drain pending microtasks plus a short wall-clock wait so jsdom's
 * MutationObserver callbacks (which are scheduled as microtasks) can
 * fire before the test asserts.
 */
async function tick(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("startSpeakerScraper", () => {
  let harness: JsdomPageHarness;
  let events: SpeakerChangeEvent[];
  let stopScraper: (() => void) | null = null;

  beforeEach(() => {
    harness = makeJsdomPage();
    events = [];
    stopScraper = null;
  });

  afterEach(() => {
    stopScraper?.();
    harness.close();
  });

  test("emits the initial active speaker when the fixture already has one", async () => {
    // Fixture starts with Alice (p-alice) flagged active. The scraper
    // should surface that as the first event on startup.
    const { stop } = startSpeakerScraper(
      harness.page,
      (event) => events.push(event),
      { meetingId: "meeting-1" },
    );
    stopScraper = stop;

    // Allow the exposeFunction promise + initial evaluate to resolve.
    await tick(20);

    expect(events.length).toBe(1);
    const event = events[0]!;
    expect(event.type).toBe("speaker.change");
    expect(event.meetingId).toBe("meeting-1");
    expect(event.speakerId).toBe("p-alice");
    expect(event.speakerName).toBe("Alice");
    // Schema compliance: timestamp must be a non-empty ISO string.
    expect(typeof event.timestamp).toBe("string");
    expect(event.timestamp.length).toBeGreaterThan(0);
    // Full shape must round-trip through the wire-protocol schema.
    expect(() => SpeakerChangeEventSchema.parse(event)).not.toThrow();
  });

  test("emits a new event when the active-speaker attribute moves to a different tile", async () => {
    const { stop } = startSpeakerScraper(
      harness.page,
      (event) => events.push(event),
      { meetingId: "meeting-1" },
    );
    stopScraper = stop;

    await tick(20);

    // Clear the initial Alice emission so the test focuses on transitions.
    expect(events.length).toBe(1);
    events.length = 0;

    // Alice → Bob.
    harness.setActiveSpeaker("p-bob");
    await tick(20);

    // Bob → Alice.
    harness.setActiveSpeaker("p-alice");
    await tick(20);

    expect(events.map((e) => e.speakerId)).toEqual(["p-bob", "p-alice"]);
    expect(events.map((e) => e.speakerName)).toEqual(["Bob", "Alice"]);
    // Every event still validates against the schema.
    for (const event of events) {
      expect(() => SpeakerChangeEventSchema.parse(event)).not.toThrow();
    }
  });

  test("dedupes consecutive identical activations", async () => {
    const { stop } = startSpeakerScraper(
      harness.page,
      (event) => events.push(event),
      { meetingId: "meeting-1" },
    );
    stopScraper = stop;

    await tick(20);
    expect(events.length).toBe(1);
    events.length = 0;

    // Re-emit Alice repeatedly. Meet can toggle attributes on the same
    // tile (e.g. between true/true via a DOM patch) without actually
    // changing who's speaking; we must not amplify those into events.
    harness.setActiveSpeaker("p-alice");
    await tick(10);
    harness.setActiveSpeaker("p-alice");
    await tick(10);
    harness.setActiveSpeaker("p-alice");
    await tick(10);

    expect(events.length).toBe(0);
  });

  test("emits nothing during the first 200ms of a static fixture (no changes)", async () => {
    // Start with NO active speaker so even the initial-emit path is a
    // no-op; this isolates the "no spurious events" guarantee.
    harness.setActiveSpeaker(null);

    const { stop } = startSpeakerScraper(
      harness.page,
      (event) => events.push(event),
      { meetingId: "meeting-1", pollMs: 50 },
    );
    stopScraper = stop;

    // Wait well past 200ms — enough for multiple poll ticks at 50ms.
    await tick(220);

    expect(events).toEqual([]);
  });

  test("stop() silences further events even when the DOM keeps changing", async () => {
    const { stop } = startSpeakerScraper(
      harness.page,
      (event) => events.push(event),
      { meetingId: "meeting-1" },
    );
    stopScraper = stop;

    await tick(20);
    events.length = 0;

    stop();

    // Further attribute flips must not produce any more events.
    harness.setActiveSpeaker("p-bob");
    await tick(20);
    harness.setActiveSpeaker("p-alice");
    await tick(20);

    expect(events).toEqual([]);
  });

  test("stop() is idempotent", async () => {
    const { stop } = startSpeakerScraper(harness.page, () => {}, {
      meetingId: "meeting-1",
    });
    stopScraper = stop;

    // Calling stop() twice must not throw.
    stop();
    expect(() => stop()).not.toThrow();
  });

  test("stamps the meetingId and a valid timestamp on every event", async () => {
    const { stop } = startSpeakerScraper(
      harness.page,
      (event) => events.push(event),
      { meetingId: "my-meeting-xyz" },
    );
    stopScraper = stop;

    await tick(20);
    harness.setActiveSpeaker("p-bob");
    await tick(20);

    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const event of events) {
      expect(event.meetingId).toBe("my-meeting-xyz");
      // ISO-8601 strings parse into a finite Date.
      const parsed = new Date(event.timestamp);
      expect(Number.isNaN(parsed.getTime())).toBe(false);
    }
  });
});
