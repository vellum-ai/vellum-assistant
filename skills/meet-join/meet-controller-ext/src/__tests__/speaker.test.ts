/**
 * Unit tests for the DOM active-speaker scraper, content-script flavor.
 *
 * The content-script scraper runs directly against `document` and
 * `MutationObserver` — there is no Playwright bridge — so the test
 * harness is much thinner than the bot-side one: install jsdom globals
 * before each test, mutate the fixture DOM to simulate Meet promoting /
 * demoting participants, and assert the scraper turns those transitions
 * into `SpeakerChangeEvent`s.
 *
 * Every mutation in this file goes through jsdom's real MutationObserver,
 * so the test exercises the same observer wiring that runs in the Meet
 * page world.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

import {
  SpeakerChangeEventSchema,
  type SpeakerChangeEvent,
} from "../../../contracts/index.js";

import { startSpeakerScraper } from "../features/speaker.js";

const FIXTURE_PATH = join(
  import.meta.dir,
  "..",
  "dom",
  "__tests__",
  "fixtures",
  "meet-dom-ingame.html",
);

interface JsdomHarness {
  dom: JSDOM;
  /** Replace the current active-speaker tile by id; `null` clears. */
  setActiveSpeaker: (participantId: string | null) => void;
  /** Restore the original globals and close the jsdom window. */
  close: () => void;
}

/**
 * Stand up a jsdom document seeded with the ingame fixture and install
 * its `window`, `document`, and `MutationObserver` onto `globalThis` so
 * the content-script scraper (which reads globals directly) sees a real
 * DOM substrate. We keep the globals live for the whole test because
 * jsdom's MutationObserver callbacks fire as microtasks that still
 * expect `document` to be defined.
 */
function makeJsdomHarness(): JsdomHarness {
  const html = readFileSync(FIXTURE_PATH, "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const { window } = dom;

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
    dom,
    setActiveSpeaker,
    close: () => {
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
 * Yield a macrotask so jsdom's MutationObserver callbacks (scheduled as
 * microtasks) and any follow-up work can run before the test asserts.
 */
async function tick(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("startSpeakerScraper", () => {
  let harness: JsdomHarness;
  let events: SpeakerChangeEvent[];
  let stopScraper: (() => void) | null = null;

  beforeEach(() => {
    harness = makeJsdomHarness();
    events = [];
    stopScraper = null;
  });

  afterEach(() => {
    stopScraper?.();
    harness.close();
  });

  test("emits the initial active speaker when the fixture already has one", async () => {
    const { stop } = startSpeakerScraper({
      meetingId: "meeting-1",
      onEvent: (event) => events.push(event),
    });
    stopScraper = stop;

    // No async setup — the scraper emits the initial snapshot
    // synchronously — but we still tick to line up with the mutation
    // tests for consistency.
    await tick(5);

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
    const { stop } = startSpeakerScraper({
      meetingId: "meeting-1",
      onEvent: (event) => events.push(event),
    });
    stopScraper = stop;

    await tick(5);

    // Clear the initial Alice emission so the test focuses on transitions.
    expect(events.length).toBe(1);
    events.length = 0;

    // Alice → Bob.
    harness.setActiveSpeaker("p-bob");
    await tick(10);

    // Bob → Alice.
    harness.setActiveSpeaker("p-alice");
    await tick(10);

    expect(events.map((e) => e.speakerId)).toEqual(["p-bob", "p-alice"]);
    expect(events.map((e) => e.speakerName)).toEqual(["Bob", "Alice"]);
    for (const event of events) {
      expect(() => SpeakerChangeEventSchema.parse(event)).not.toThrow();
    }
  });

  test("dedupes consecutive identical activations", async () => {
    const { stop } = startSpeakerScraper({
      meetingId: "meeting-1",
      onEvent: (event) => events.push(event),
    });
    stopScraper = stop;

    await tick(5);
    expect(events.length).toBe(1);
    events.length = 0;

    // Re-emit Alice repeatedly. Meet can toggle attributes on the same
    // tile (e.g. true→true via a DOM patch) without actually changing
    // who's speaking; we must not amplify those into events.
    harness.setActiveSpeaker("p-alice");
    await tick(10);
    harness.setActiveSpeaker("p-alice");
    await tick(10);
    harness.setActiveSpeaker("p-alice");
    await tick(10);

    expect(events.length).toBe(0);
  });

  test("emits nothing over a static fixture (no changes)", async () => {
    // Start with NO active speaker so even the initial-emit path is a
    // no-op; this isolates the "no spurious events" guarantee.
    harness.setActiveSpeaker(null);

    const { stop } = startSpeakerScraper({
      meetingId: "meeting-1",
      onEvent: (event) => events.push(event),
    });
    stopScraper = stop;

    // Wait a while to catch any spurious timers or latent observer work.
    await tick(220);

    expect(events).toEqual([]);
  });

  test("stop() silences further events even when the DOM keeps changing", async () => {
    const { stop } = startSpeakerScraper({
      meetingId: "meeting-1",
      onEvent: (event) => events.push(event),
    });
    stopScraper = stop;

    await tick(5);
    events.length = 0;

    stop();

    // Further attribute flips must not produce any more events.
    harness.setActiveSpeaker("p-bob");
    await tick(10);
    harness.setActiveSpeaker("p-alice");
    await tick(10);

    expect(events).toEqual([]);
  });

  test("stop() is idempotent", () => {
    const { stop } = startSpeakerScraper({
      meetingId: "meeting-1",
      onEvent: () => {},
    });
    stopScraper = stop;

    stop();
    expect(() => stop()).not.toThrow();
  });

  test("stamps the meetingId and a valid timestamp on every event", async () => {
    const { stop } = startSpeakerScraper({
      meetingId: "my-meeting-xyz",
      onEvent: (event) => events.push(event),
    });
    stopScraper = stop;

    await tick(5);
    harness.setActiveSpeaker("p-bob");
    await tick(10);

    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const event of events) {
      expect(event.meetingId).toBe("my-meeting-xyz");
      const parsed = new Date(event.timestamp);
      expect(Number.isNaN(parsed.getTime())).toBe(false);
    }
  });
});
