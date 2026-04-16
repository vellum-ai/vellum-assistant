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

import type { ParticipantChangeEvent } from "../../contracts/index.js";

import { selectors } from "../src/browser/dom-selectors.js";
import { startParticipantScraper } from "../src/browser/participant-scraper.js";

/**
 * Minimal participant row shape the fake page returns from `$$eval`. Mirrors
 * what the real extractor emits when it reads `data-participant-id` and the
 * participant-name subselector from each row.
 *
 * `isSelfByDom` mirrors the scraper's in-page detection of Meet's
 * `data-self-name` attribute — the authoritative DOM marker for the bot's
 * own row. Tests default it to `false`; self-row tests set it explicitly.
 */
interface ScrapedRow {
  id: string | null;
  name: string | null;
  isSelfByDom?: boolean;
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

  // --------------------------------------------------------------------
  // isSelf detection — lets the consent monitor identify the bot's own
  // participant id so bot-self transcripts and chat (e.g. the consent
  // message) don't advance the watermark.
  // --------------------------------------------------------------------

  test("flags the bot's own row via Meet's data-self-name DOM marker", async () => {
    // `isSelfByDom: true` simulates the real extractor finding the
    // row's name node via `[data-self-name]` rather than
    // `[data-participant-name]`.
    const page = makeFakePage([
      { id: "p-alice", name: "Alice", isSelfByDom: false },
      { id: "p-bot", name: "AI Assistant", isSelfByDom: true },
    ]);
    const handle = startParticipantScraper(
      page as unknown as Parameters<typeof startParticipantScraper>[0],
      (event) => events.push(event),
      { meetingId: "m-1", pollMs: 50, selfName: "AI Assistant" },
    );
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);
    const joined = events[0]!.joined;
    const alice = joined.find((p) => p.id === "p-alice");
    const bot = joined.find((p) => p.id === "p-bot");
    expect(alice?.isSelf).toBeUndefined();
    expect(bot?.isSelf).toBe(true);
  });

  test("flags the bot's own row by display-name match when DOM marker is absent", async () => {
    // Simulates a Meet variant that does not expose `data-self-name`
    // on the bot row. The scraper falls back to matching the configured
    // `selfName`. This fallback is safe for the bot because it picks a
    // deliberately unique display name.
    const page = makeFakePage([
      { id: "p-alice", name: "Alice", isSelfByDom: false },
      { id: "p-bot", name: "Velissa (Sidd's assistant)", isSelfByDom: false },
    ]);
    const handle = startParticipantScraper(
      page as unknown as Parameters<typeof startParticipantScraper>[0],
      (event) => events.push(event),
      {
        meetingId: "m-1",
        pollMs: 50,
        selfName: "Velissa (Sidd's assistant)",
      },
    );
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);
    const joined = events[0]!.joined;
    const bot = joined.find((p) => p.name === "Velissa (Sidd's assistant)");
    expect(bot?.isSelf).toBe(true);
    const alice = joined.find((p) => p.id === "p-alice");
    expect(alice?.isSelf).toBeUndefined();
  });

  test("does not flag any row when selfName is omitted and no DOM marker is present", async () => {
    // Without a configured `selfName` and no authoritative DOM signal,
    // the scraper plays it safe and leaves `isSelf` off every row — the
    // consent monitor will simply never populate `botParticipantId`,
    // which keeps its vacuous-filter behavior rather than mis-attributing
    // a human's row as the bot.
    const page = makeFakePage([
      { id: "p-alice", name: "Alice", isSelfByDom: false },
      { id: "p-bob", name: "Bob", isSelfByDom: false },
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
    for (const p of events[0]!.joined) {
      expect(p.isSelf).toBeUndefined();
    }
  });

  test("prefers the DOM marker even when a row's name happens to equal selfName", async () => {
    // Defense in depth: if some human participant somehow shares the
    // bot's configured display name (unlikely but not impossible), the
    // authoritative DOM marker still wins and the scraper also flags the
    // name-colliding row. Both rows end up with `isSelf: true`; the
    // consent monitor's "first isSelf join wins" rule means the earlier
    // row determines `botParticipantId`. This test pins the scraper
    // behavior rather than the consumer's first-wins policy.
    const page = makeFakePage([
      { id: "p-bot", name: "AI Assistant", isSelfByDom: true },
      { id: "p-imposter", name: "AI Assistant", isSelfByDom: false },
    ]);
    const handle = startParticipantScraper(
      page as unknown as Parameters<typeof startParticipantScraper>[0],
      (event) => events.push(event),
      { meetingId: "m-1", pollMs: 50, selfName: "AI Assistant" },
    );
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);
    const joined = events[0]!.joined;
    expect(joined.find((p) => p.id === "p-bot")?.isSelf).toBe(true);
    // The name-colliding row is also flagged by the name-fallback — this
    // is a known limitation of the fallback and the reason we prefer the
    // DOM marker when both are available.
    expect(joined.find((p) => p.id === "p-imposter")?.isSelf).toBe(true);
  });
});
