/**
 * Tests for the content-script participant scraper.
 *
 * Ported from `skills/meet-join/bot/__tests__/participant-scraper.test.ts`.
 * The bot-side tests used a hand-rolled fake `Page` object that responded
 * to the Playwright `$`/`$$eval`/`click` surface; this module runs the
 * scraper against a real jsdom document and mutates the DOM directly to
 * simulate Meet's participant panel changing over time.
 *
 * Fixture loading follows the pattern established by
 * `src/dom/__tests__/selectors.test.ts`: load the committed HTML into a
 * JSDOM instance and install it as the module-global `document`/`window`
 * so the scraper's `document.querySelector*` calls resolve against it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { JSDOM } from "jsdom";

import type { ExtensionToBotMessage } from "../../../contracts/native-messaging.js";
import type { ParticipantChangeEvent } from "../../../contracts/events.js";

import { startParticipantScraper } from "../features/participants.js";

const FIXTURE_DIR = joinPath(import.meta.dir, "..", "dom", "__tests__", "fixtures");

interface InstalledDom {
  dom: JSDOM;
  uninstall: () => void;
}

/**
 * Install a JSDOM instance as the module-global `window`/`document` so
 * `document.querySelectorAll` inside the scraper resolves. Tests call
 * `uninstall()` in `afterEach` to restore the previous state.
 */
function installDom(html: string): InstalledDom {
  const dom = new JSDOM(html);
  const g = globalThis as unknown as {
    window?: unknown;
    document?: unknown;
    HTMLElement?: unknown;
  };
  const prevWindow = g.window;
  const prevDocument = g.document;
  const prevHTMLElement = g.HTMLElement;
  g.window = dom.window;
  g.document = dom.window.document;
  // The scraper uses `nameEl instanceof HTMLElement` to check the
  // data-self-name marker. Wire jsdom's HTMLElement into the global
  // namespace so the instanceof check holds against jsdom-created nodes.
  g.HTMLElement = dom.window.HTMLElement;
  return {
    dom,
    uninstall: () => {
      g.window = prevWindow;
      g.document = prevDocument;
      g.HTMLElement = prevHTMLElement;
    },
  };
}

/** Load an in-meeting fixture and install it as the active document. */
function installIngameFixture(): InstalledDom {
  const html = readFileSync(
    joinPath(FIXTURE_DIR, "meet-dom-ingame.html"),
    "utf8",
  );
  return installDom(html);
}

/**
 * Minimal DOM builder for a participant panel with arbitrary rows. The
 * bot-side tests drove the fake `Page` with plain JS objects; the
 * content-script equivalent is to render equivalent list-item markup
 * into a real (jsdom) document.
 */
interface ParticipantRowSpec {
  id?: string | null;
  name: string;
  /** Use `data-self-name` instead of `data-participant-name`. */
  isSelfByDom?: boolean;
}

function panelHtml(rows: ParticipantRowSpec[]): string {
  const listItems = rows
    .map((row) => {
      const idAttr =
        row.id === null || row.id === undefined
          ? ""
          : ` data-participant-id="${row.id}"`;
      const nameAttr = row.isSelfByDom
        ? "data-self-name"
        : "data-participant-name";
      return `<div role="listitem"${idAttr}><span ${nameAttr}>${row.name}</span></div>`;
    })
    .join("");
  return `
    <!doctype html>
    <html><body>
      <button aria-label="Show everyone"></button>
      <div role="list" aria-label="Participants">${listItems}</div>
    </body></html>
  `;
}

function installPanelFixture(rows: ParticipantRowSpec[]): InstalledDom {
  return installDom(panelHtml(rows));
}

/** Replace the participant list's children with a new row set. */
function replaceRows(dom: JSDOM, rows: ParticipantRowSpec[]): void {
  const list = dom.window.document.querySelector(
    '[role="list"][aria-label="Participants"]',
  );
  if (!list) throw new Error("participant list not present in fixture");
  list.innerHTML = rows
    .map((row) => {
      const idAttr =
        row.id === null || row.id === undefined
          ? ""
          : ` data-participant-id="${row.id}"`;
      const nameAttr = row.isSelfByDom
        ? "data-self-name"
        : "data-participant-name";
      return `<div role="listitem"${idAttr}><span ${nameAttr}>${row.name}</span></div>`;
    })
    .join("");
}

/** Wait `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drain a handful of microtask ticks so the synchronous initial poll fires. */
async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Narrow helper — every event the scraper emits is a
 * `participant.change`. The `ExtensionToBotMessage` union includes other
 * variants for future use, so we cast at the point of assertion.
 */
function asParticipantChange(msg: ExtensionToBotMessage): ParticipantChangeEvent {
  if (msg.type !== "participant.change") {
    throw new Error(`expected participant.change event, got ${msg.type}`);
  }
  return msg;
}

describe("startParticipantScraper", () => {
  let installed: InstalledDom | null = null;
  let events: ExtensionToBotMessage[];
  let handles: Array<{ stop: () => void }>;

  beforeEach(() => {
    events = [];
    handles = [];
  });

  afterEach(() => {
    for (const handle of handles) handle.stop();
    if (installed) {
      installed.uninstall();
      installed = null;
    }
  });

  test("emits initial snapshot with every current participant as joined", async () => {
    installed = installPanelFixture([
      { id: "p-alice", name: "Alice" },
      { id: "p-bob", name: "Bob" },
    ]);
    const handle = startParticipantScraper({
      meetingId: "m-1",
      pollMs: 50,
      onEvent: (ev) => events.push(ev),
    });
    handles.push(handle);

    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);
    const initial = asParticipantChange(events[0]!);
    expect(initial.type).toBe("participant.change");
    expect(initial.meetingId).toBe("m-1");
    expect(initial.left).toHaveLength(0);
    expect(initial.joined).toHaveLength(2);
    const joinedIds = initial.joined.map((p) => p.id).sort();
    expect(joinedIds).toEqual(["p-alice", "p-bob"]);
  });

  test("initial snapshot reads all participants from the full in-game fixture", async () => {
    // The committed meet-dom-ingame fixture has Alice, Bob, and "You".
    installed = installIngameFixture();
    const handle = startParticipantScraper({
      meetingId: "m-ingame",
      pollMs: 50,
      onEvent: (ev) => events.push(ev),
    });
    handles.push(handle);

    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);
    const initial = asParticipantChange(events[0]!);
    const joinedIds = initial.joined.map((p) => p.id).sort();
    expect(joinedIds).toEqual(["p-alice", "p-bob", "p-you"]);
    expect(initial.left).toHaveLength(0);
  });

  test("opens the participants panel when it starts closed", async () => {
    // No list container present — only the toggle button. The scraper
    // should click the toggle, which our lightweight stub responds to by
    // injecting the list container into the DOM.
    installed = installDom(`
      <!doctype html>
      <html><body>
        <button id="toggle" aria-label="Show everyone"></button>
        <div id="holder"></div>
      </body></html>
    `);
    const dom = installed.dom;
    let toggleClicks = 0;
    const toggle = dom.window.document.getElementById("toggle");
    expect(toggle).not.toBeNull();
    toggle!.addEventListener("click", () => {
      toggleClicks += 1;
      const holder = dom.window.document.getElementById("holder");
      if (holder) {
        holder.innerHTML =
          '<div role="list" aria-label="Participants"><div role="listitem" data-participant-id="p-alice"><span data-participant-name>Alice</span></div></div>';
      }
    });

    const handle = startParticipantScraper({
      meetingId: "m-1",
      pollMs: 50,
      onEvent: (ev) => events.push(ev),
    });
    handles.push(handle);

    await drainMicrotasks();
    await sleep(10);

    expect(toggleClicks).toBe(1);
    // After opening, the first poll sees Alice.
    expect(events.length).toBeGreaterThanOrEqual(1);
    const first = asParticipantChange(events[0]!);
    expect(first.joined.map((p) => p.id)).toEqual(["p-alice"]);
  });

  test("does not re-click the toggle when the panel is already open", async () => {
    installed = installPanelFixture([{ id: "p-alice", name: "Alice" }]);
    let toggleClicks = 0;
    const toggle = installed.dom.window.document.querySelector<HTMLElement>(
      'button[aria-label="Show everyone"]',
    );
    expect(toggle).not.toBeNull();
    toggle!.addEventListener("click", () => {
      toggleClicks += 1;
    });

    const handle = startParticipantScraper({
      meetingId: "m-1",
      pollMs: 50,
      onEvent: (ev) => events.push(ev),
    });
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    // The list container is already present in the fixture, so the
    // scraper should not click the toggle.
    expect(toggleClicks).toBe(0);
  });

  test("emits only a diff event when participants change between polls", async () => {
    installed = installPanelFixture([
      { id: "p-alice", name: "Alice" },
      { id: "p-bob", name: "Bob" },
    ]);
    const dom = installed.dom;
    const handle = startParticipantScraper({
      meetingId: "m-1",
      pollMs: 30,
      onEvent: (ev) => events.push(ev),
    });
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);

    // Bob leaves, Carol joins.
    replaceRows(dom, [
      { id: "p-alice", name: "Alice" },
      { id: "p-carol", name: "Carol" },
    ]);

    // Wait for a couple of poll intervals to elapse.
    await sleep(80);

    expect(events.length).toBe(2);
    const diff = asParticipantChange(events[1]!);
    expect(diff.joined.map((p) => p.id)).toEqual(["p-carol"]);
    expect(diff.left.map((p) => p.id)).toEqual(["p-bob"]);
    expect(diff.meetingId).toBe("m-1");
  });

  test("does not emit when the participant set is unchanged", async () => {
    installed = installPanelFixture([{ id: "p-alice", name: "Alice" }]);
    const handle = startParticipantScraper({
      meetingId: "m-1",
      pollMs: 30,
      onEvent: (ev) => events.push(ev),
    });
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);

    // Let a few poll intervals elapse without mutating the row list.
    await sleep(100);

    expect(events.length).toBe(1);
  });

  test("stop() cancels further emissions", async () => {
    installed = installPanelFixture([{ id: "p-alice", name: "Alice" }]);
    const dom = installed.dom;
    const handle = startParticipantScraper({
      meetingId: "m-1",
      pollMs: 30,
      onEvent: (ev) => events.push(ev),
    });
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);
    handle.stop();

    // Mutate the DOM so a running poll *would* fire a diff event; since we
    // stopped, the scraper must stay quiet.
    replaceRows(dom, [
      { id: "p-alice", name: "Alice" },
      { id: "p-bob", name: "Bob" },
    ]);
    await sleep(100);

    expect(events.length).toBe(1);
  });

  test("stop() is idempotent — calling it twice does not throw", () => {
    installed = installPanelFixture([{ id: "p-alice", name: "Alice" }]);
    const handle = startParticipantScraper({
      meetingId: "m-1",
      pollMs: 30,
      onEvent: (ev) => events.push(ev),
    });
    handle.stop();
    expect(() => handle.stop()).not.toThrow();
  });

  test("emits an ISO timestamp in every event", async () => {
    installed = installPanelFixture([{ id: "p-alice", name: "Alice" }]);
    const before = new Date().toISOString();
    const handle = startParticipantScraper({
      meetingId: "m-1",
      pollMs: 50,
      onEvent: (ev) => events.push(ev),
    });
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);
    const after = new Date().toISOString();

    const initial = asParticipantChange(events[0]!);
    expect(initial.timestamp >= before).toBe(true);
    expect(initial.timestamp <= after).toBe(true);
  });

  test("skips rows missing data-participant-id (the selector filters them out)", async () => {
    // Documents a semantic difference from the bot-side fake Page: the real
    // CSS selector `[role="listitem"][data-participant-id]` filters out
    // partial rows. The `row.id ?? name` fallback in the scraper remains as
    // defensive depth-in-coverage for a row whose attribute somehow reads
    // back as null despite the selector matching — not expected in practice
    // but cheap to keep.
    installed = installPanelFixture([
      // No data-participant-id → skipped by the selector.
      { id: null, name: "Alice" },
      { id: "p-bob", name: "Bob" },
    ]);
    const handle = startParticipantScraper({
      meetingId: "m-1",
      pollMs: 50,
      onEvent: (ev) => events.push(ev),
    });
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);
    const initial = asParticipantChange(events[0]!);
    const joinedIds = initial.joined.map((p) => p.id).sort();
    expect(joinedIds).toEqual(["p-bob"]);
  });

  test("restarting a scraper on the same DOM re-emits its initial snapshot", async () => {
    // Simulates the idempotency requirement: if a caller stops and restarts
    // the scraper on a DOM it has already seen, the *restart* should emit
    // its initial snapshot but downstream consumers are responsible for
    // matching against their own state. The scraper itself treats each
    // lifecycle as independent — this test just pins that expectation.
    installed = installPanelFixture([{ id: "p-alice", name: "Alice" }]);
    const first = startParticipantScraper({
      meetingId: "m-1",
      pollMs: 30,
      onEvent: (ev) => events.push(ev),
    });
    await sleep(50);
    first.stop();
    const afterFirst = events.length;

    // Restart — re-emits initial snapshot once, then stays quiet while the
    // DOM is unchanged.
    const second = startParticipantScraper({
      meetingId: "m-1",
      pollMs: 30,
      onEvent: (ev) => events.push(ev),
    });
    handles.push(second);
    await sleep(100);

    // One new emission (the restart's initial snapshot), no spurious join/leave
    // churn from the already-known participants.
    expect(events.length - afterFirst).toBe(1);
    const restart = asParticipantChange(events[events.length - 1]!);
    expect(restart.left).toHaveLength(0);
    expect(restart.joined.map((p) => p.id)).toEqual(["p-alice"]);
  });

  // --------------------------------------------------------------------
  // isSelf detection — lets the consent monitor identify the bot's own
  // participant id so bot-self transcripts and chat (e.g. the consent
  // message) don't advance the watermark.
  // --------------------------------------------------------------------

  test("flags the bot's own row via Meet's data-self-name DOM marker", async () => {
    installed = installPanelFixture([
      { id: "p-alice", name: "Alice", isSelfByDom: false },
      { id: "p-bot", name: "AI Assistant", isSelfByDom: true },
    ]);
    const handle = startParticipantScraper({
      meetingId: "m-1",
      pollMs: 50,
      selfName: "AI Assistant",
      onEvent: (ev) => events.push(ev),
    });
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);
    const joined = asParticipantChange(events[0]!).joined;
    const alice = joined.find((p) => p.id === "p-alice");
    const bot = joined.find((p) => p.id === "p-bot");
    expect(alice?.isSelf).toBeUndefined();
    expect(bot?.isSelf).toBe(true);
  });

  test("flags the bot's own row by display-name match when DOM marker is absent", async () => {
    installed = installPanelFixture([
      { id: "p-alice", name: "Alice", isSelfByDom: false },
      { id: "p-bot", name: "Aria", isSelfByDom: false },
    ]);
    const handle = startParticipantScraper({
      meetingId: "m-1",
      pollMs: 50,
      selfName: "Aria",
      onEvent: (ev) => events.push(ev),
    });
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);
    const joined = asParticipantChange(events[0]!).joined;
    const bot = joined.find((p) => p.name === "Aria");
    expect(bot?.isSelf).toBe(true);
    const alice = joined.find((p) => p.id === "p-alice");
    expect(alice?.isSelf).toBeUndefined();
  });

  test("does not flag any row when selfName is omitted and no DOM marker is present", async () => {
    installed = installPanelFixture([
      { id: "p-alice", name: "Alice", isSelfByDom: false },
      { id: "p-bob", name: "Bob", isSelfByDom: false },
    ]);
    const handle = startParticipantScraper({
      meetingId: "m-1",
      pollMs: 50,
      onEvent: (ev) => events.push(ev),
    });
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);
    const joined = asParticipantChange(events[0]!).joined;
    for (const p of joined) {
      expect(p.isSelf).toBeUndefined();
    }
  });

  test("prefers the DOM marker even when a row's name happens to equal selfName", async () => {
    installed = installPanelFixture([
      { id: "p-bot", name: "AI Assistant", isSelfByDom: true },
      { id: "p-imposter", name: "AI Assistant", isSelfByDom: false },
    ]);
    const handle = startParticipantScraper({
      meetingId: "m-1",
      pollMs: 50,
      selfName: "AI Assistant",
      onEvent: (ev) => events.push(ev),
    });
    handles.push(handle);
    await drainMicrotasks();
    await sleep(10);

    expect(events.length).toBe(1);
    const joined = asParticipantChange(events[0]!).joined;
    expect(joined.find((p) => p.id === "p-bot")?.isSelf).toBe(true);
    // The name-colliding row is also flagged by the name-fallback — this
    // is a known limitation of the fallback and the reason we prefer the
    // DOM marker when both are available.
    expect(joined.find((p) => p.id === "p-imposter")?.isSelf).toBe(true);
  });
});
