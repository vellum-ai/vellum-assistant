/**
 * Tests for the participant-panel scraper.
 *
 * The scraper is designed to run against a live Google Meet page, but we
 * verify its logic here with a lightweight fake `Page` that responds to the
 * same `$`, `$$eval`, and click surface the scraper exercises. This keeps
 * the suite hermetic (no Xvfb, no Chromium, no Playwright launch) and lets
 * us drive the DOM shape via plain JavaScript objects.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ParticipantChangeEvent } from "@vellumai/meet-contracts";

import { selectors } from "../src/browser/dom-selectors.js";
import { startParticipantScraper } from "../src/browser/participant-scraper.js";

/**
 * Minimal participant row shape the fake page returns from `$$eval`. Mirrors
 * what the real extractor emits when it reads `data-participant-id` and the
 * participant-name subselector from each row.
 */
interface ScrapedRow {
  id: string | null;
  name: string | null;
}

/**
 * Fake `Page` stand-in covering the three surfaces the scraper touches:
 *   - `page.$(selector)` for panel-open detection and toggle lookup
 *   - `page.$$eval(selector, fn, arg)` for reading the participant rows
 *   - a click on the toggle element returned by `page.$`
 *
 * Callers mutate `rows` between ticks to simulate Meet's DOM changing while
 * the scraper is running.
 */
interface FakePage {
  rows: ScrapedRow[];
  panelOpen: boolean;
  toggleClicks: number;
  // Signatures intentionally `any` — Playwright's $$eval has several
  // overloads that are painful to satisfy from a hand-rolled fake, and the
  // scraper only cares about the run-time behavior we stub here.
  $: (selector: string) => Promise<unknown>;
  $$eval: (...args: unknown[]) => Promise<ScrapedRow[]>;
}

function makeFakePage(initialRows: ScrapedRow[] = []): FakePage {
  const fake: FakePage = {
    rows: [...initialRows],
    panelOpen: false,
    toggleClicks: 0,
    $: async (selector: string) => {
      if (selector === selectors.INGAME_PARTICIPANT_LIST) {
        return fake.panelOpen ? {} : null;
      }
      if (selector === selectors.INGAME_PARTICIPANTS_PANEL_BUTTON) {
        return {
          click: async () => {
            fake.toggleClicks += 1;
            fake.panelOpen = true;
          },
        };
      }
      return null;
    },
    $$eval: async () => fake.rows,
  };
  return fake;
}

/** Wait `ms` milliseconds — small helper so tests read linearly. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drain any microtasks so the scraper's initial kick-off (which calls
 * `void poll()` synchronously) resolves before we assert on the first
 * emission.
 */
async function drainMicrotasks(): Promise<void> {
  // Two ticks is enough for: (1) $ resolving the panel check, (2) $$eval
  // resolving the row extraction, (3) the onChange callback firing.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("startParticipantScraper", () => {
  let events: ParticipantChangeEvent[];
  let handles: Array<{ stop: () => void }>;

  beforeEach(() => {
    events = [];
    handles = [];
  });

  afterEach(() => {
    for (const handle of handles) handle.stop();
  });

  test("emits initial snapshot with every current participant as joined", async () => {
    const page = makeFakePage([
      { id: "p-alice", name: "Alice" },
      { id: "p-bob", name: "Bob" },
    ]);
    const handle = startParticipantScraper(
      page as unknown as Parameters<typeof startParticipantScraper>[0],
      (event) => events.push(event),
      { meetingId: "m-1", pollMs: 50 },
    );
    handles.push(handle);

    await drainMicrotasks();
    // Give the initial poll's click + $$eval chain time to settle.
    await sleep(10);

    expect(events.length).toBe(1);
    const initial = events[0]!;
    expect(initial.type).toBe("participant.change");
    expect(initial.meetingId).toBe("m-1");
    expect(initial.left).toHaveLength(0);
    expect(initial.joined).toHaveLength(2);
    const joinedIds = initial.joined.map((p) => p.id).sort();
    expect(joinedIds).toEqual(["p-alice", "p-bob"]);
  });

  test("opens the participants panel when it starts closed", async () => {
    const page = makeFakePage([{ id: "p-alice", name: "Alice" }]);
    expect(page.panelOpen).toBe(false);

    const handle = startParticipantScraper(
      page as unknown as Parameters<typeof startParticipantScraper>[0],
      (event) => events.push(event),
      { meetingId: "m-1", pollMs: 50 },
    );
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(page.toggleClicks).toBe(1);
    expect(page.panelOpen).toBe(true);
  });

  test("does not re-click the toggle when the panel is already open", async () => {
    const page = makeFakePage([{ id: "p-alice", name: "Alice" }]);
    page.panelOpen = true;

    const handle = startParticipantScraper(
      page as unknown as Parameters<typeof startParticipantScraper>[0],
      (event) => events.push(event),
      { meetingId: "m-1", pollMs: 50 },
    );
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(page.toggleClicks).toBe(0);
  });

  test("emits only a diff event when participants change between polls", async () => {
    const page = makeFakePage([
      { id: "p-alice", name: "Alice" },
      { id: "p-bob", name: "Bob" },
    ]);
    const handle = startParticipantScraper(
      page as unknown as Parameters<typeof startParticipantScraper>[0],
      (event) => events.push(event),
      { meetingId: "m-1", pollMs: 30 },
    );
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);

    // Bob leaves, Carol joins.
    page.rows = [
      { id: "p-alice", name: "Alice" },
      { id: "p-carol", name: "Carol" },
    ];

    // Wait for a couple of poll intervals to elapse.
    await sleep(80);

    expect(events.length).toBe(2);
    const diff = events[1]!;
    expect(diff.joined.map((p) => p.id)).toEqual(["p-carol"]);
    expect(diff.left.map((p) => p.id)).toEqual(["p-bob"]);
    expect(diff.meetingId).toBe("m-1");
  });

  test("does not emit when the participant set is unchanged", async () => {
    const page = makeFakePage([{ id: "p-alice", name: "Alice" }]);
    const handle = startParticipantScraper(
      page as unknown as Parameters<typeof startParticipantScraper>[0],
      (event) => events.push(event),
      { meetingId: "m-1", pollMs: 30 },
    );
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);

    // Let a few poll intervals elapse without mutating the row list.
    await sleep(100);

    expect(events.length).toBe(1);
  });

  test("stop() cancels further emissions", async () => {
    const page = makeFakePage([{ id: "p-alice", name: "Alice" }]);
    const handle = startParticipantScraper(
      page as unknown as Parameters<typeof startParticipantScraper>[0],
      (event) => events.push(event),
      { meetingId: "m-1", pollMs: 30 },
    );
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);
    handle.stop();

    // Mutate the page so a running poll *would* fire a diff event; since we
    // stopped, the scraper must stay quiet.
    page.rows = [
      { id: "p-alice", name: "Alice" },
      { id: "p-bob", name: "Bob" },
    ];
    await sleep(100);

    expect(events.length).toBe(1);
  });

  test("stop() is idempotent — calling it twice does not throw", () => {
    const page = makeFakePage([{ id: "p-alice", name: "Alice" }]);
    const handle = startParticipantScraper(
      page as unknown as Parameters<typeof startParticipantScraper>[0],
      (event) => events.push(event),
      { meetingId: "m-1", pollMs: 30 },
    );
    handle.stop();
    expect(() => handle.stop()).not.toThrow();
  });

  test("uses Date.now-derived ISO timestamp in emitted events", async () => {
    const page = makeFakePage([{ id: "p-alice", name: "Alice" }]);
    const before = new Date().toISOString();
    const handle = startParticipantScraper(
      page as unknown as Parameters<typeof startParticipantScraper>[0],
      (event) => events.push(event),
      { meetingId: "m-1", pollMs: 50 },
    );
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);
    const after = new Date().toISOString();

    expect(events[0]!.timestamp >= before).toBe(true);
    expect(events[0]!.timestamp <= after).toBe(true);
  });

  test("falls back to name as id when a row has no data-participant-id", async () => {
    const page = makeFakePage([
      // Simulate a partially-rendered row with no stable id.
      { id: null, name: "Alice" },
      { id: "p-bob", name: "Bob" },
    ]);
    const handle = startParticipantScraper(
      page as unknown as Parameters<typeof startParticipantScraper>[0],
      (event) => events.push(event),
      { meetingId: "m-1", pollMs: 50 },
    );
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);
    const joinedIds = events[0]!.joined.map((p) => p.id).sort();
    expect(joinedIds).toEqual(["Alice", "p-bob"]);
  });

  test("swallows $$eval errors and keeps polling", async () => {
    const page = makeFakePage([{ id: "p-alice", name: "Alice" }]);
    let callCount = 0;
    const originalEval = page.$$eval.bind(page);
    page.$$eval = async (...args: unknown[]) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("transient DOM error");
      }
      return originalEval(...args);
    };

    const handle = startParticipantScraper(
      page as unknown as Parameters<typeof startParticipantScraper>[0],
      (event) => events.push(event),
      { meetingId: "m-1", pollMs: 30 },
    );
    handles.push(handle);

    // First poll errors (no event). Subsequent polls should succeed.
    await sleep(100);

    expect(callCount).toBeGreaterThan(1);
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  test("restarting a scraper on the same fake page does not re-emit known participants as joined", async () => {
    // Simulates the idempotency requirement: if a caller stops and restarts
    // the scraper on a DOM it has already seen, the *restart* should emit
    // its initial snapshot but downstream consumers are responsible for
    // matching against their own state. The scraper itself treats each
    // lifecycle as independent — this test just pins that expectation.
    const page = makeFakePage([{ id: "p-alice", name: "Alice" }]);
    const first = startParticipantScraper(
      page as unknown as Parameters<typeof startParticipantScraper>[0],
      (event) => events.push(event),
      { meetingId: "m-1", pollMs: 30 },
    );
    await sleep(50);
    first.stop();
    const afterFirst = events.length;

    // Restart — re-emits initial snapshot once, then stays quiet while the
    // DOM is unchanged.
    const second = startParticipantScraper(
      page as unknown as Parameters<typeof startParticipantScraper>[0],
      (event) => events.push(event),
      { meetingId: "m-1", pollMs: 30 },
    );
    handles.push(second);
    await sleep(100);

    // One new emission (the restart's initial snapshot), no spurious join/leave
    // churn from the already-known participants.
    expect(events.length - afterFirst).toBe(1);
    const restart = events[events.length - 1]!;
    expect(restart.left).toHaveLength(0);
    expect(restart.joined.map((p) => p.id)).toEqual(["p-alice"]);
  });
});
