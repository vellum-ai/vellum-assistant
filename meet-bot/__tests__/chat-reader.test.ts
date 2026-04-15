/**
 * Unit tests for `startChatReader`.
 *
 * We don't spin up a real Playwright browser here — instead we hand the
 * reader a tiny fake `Page` backed by a JSDOM document. The fake implements
 * only the subset of Playwright's Page surface the reader actually calls
 * (`evaluate`, `exposeFunction`, `$`), which is enough to exercise:
 *
 *   - Panel-open detection + toggle click.
 *   - In-page `MutationObserver` wiring (JSDOM provides a real
 *     `MutationObserver`, so the observer runs for real).
 *   - The `page.exposeFunction` bridge that forwards raw messages back to
 *     the bot-side callback.
 *   - Self-filter + dedupe in the bot-side handler.
 *
 * The fallback polling loop is covered by explicitly injecting a failing
 * `exposeFunction` and asserting that the reader still surfaces messages.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

import type { InboundChatEvent } from "@vellumai/meet-contracts";
import type { Page } from "playwright";

import { startChatReader } from "../src/browser/chat-reader.js";
import { chatSelectors } from "../src/browser/dom-selectors.js";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");
const CHAT_FIXTURE = readFileSync(
  join(FIXTURE_DIR, "meet-dom-chat.html"),
  "utf8",
);

/**
 * Shape of a bridge handler installed by `page.exposeFunction`. The fake
 * Page routes calls through this map so `window[name](...)` in the page
 * context calls the bot-side callback.
 */
type BridgeFn = (...args: unknown[]) => unknown;

interface FakePageOptions {
  /** Force `exposeFunction` to reject — triggers the polling fallback. */
  failExposeFunction?: boolean;
}

interface FakePage {
  page: Page;
  dom: JSDOM;
  document: Document;
  /** Append a message <div> to the rendered chat list. */
  appendMessage: (opts: {
    id: string;
    sender: string;
    text: string;
    datetime?: string;
    isSelf?: boolean;
  }) => void;
  /** Remove the message list entirely so `ensurePanelOpen` has to click. */
  closePanel: () => void;
  /** Count of times the toggle button was clicked. */
  panelToggleClicks: () => number;
}

/**
 * Build a fake Playwright `Page` wrapping a JSDOM document. Only the subset
 * of Page methods used by `chat-reader.ts` is implemented.
 */
function createFakePage(
  html: string,
  opts: FakePageOptions = {},
): FakePage {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const window = dom.window;
  const document = window.document;

  // The chat fixture alone doesn't carry the toolbar toggle button (that
  // lives in the in-game fixture). Inject one here so ensurePanelOpen has
  // something to click on the closed-panel code path.
  if (!document.querySelector(chatSelectors.PANEL_BUTTON)) {
    const toggle = document.createElement("button");
    toggle.setAttribute("type", "button");
    toggle.setAttribute("aria-label", "Chat with everyone");
    toggle.textContent = "Chat";
    document.body.appendChild(toggle);
  }

  // JSDOM exposes MutationObserver, DOM APIs, Element, etc. on its window —
  // we mirror the globals the reader's `evaluate` body needs onto our own
  // global so the evaluator below has a consistent view.
  const pageGlobals = {
    document,
    window,
    MutationObserver: window.MutationObserver,
    Date,
    Number,
    Array,
    Set,
  } as Record<string, unknown>;

  const bridges = new Map<string, BridgeFn>();
  let toggleClicks = 0;

  // Wire the chat toggle so ensurePanelOpen's fallback path can recreate the
  // message list when invoked.
  const attachToggleHandler = (): void => {
    const toggle = document.querySelector(chatSelectors.PANEL_BUTTON);
    if (!toggle) return;
    toggle.addEventListener("click", () => {
      toggleClicks += 1;
      // If the message list has been removed, recreate it so a subsequent
      // query succeeds.
      if (!document.querySelector('[role="list"][aria-label="Chat messages"]')) {
        const aside = document.querySelector("aside");
        const list = document.createElement("div");
        list.setAttribute("role", "list");
        list.setAttribute("aria-label", "Chat messages");
        aside?.insertBefore(list, aside.firstChild);
      }
    });
  };
  attachToggleHandler();

  // `fn` is what the caller passes to page.evaluate. Playwright serializes
  // it to a string and runs it in the page; JSDOM can't re-parse arbitrary
  // strings robustly, so we invoke the function directly but with a
  // controlled `window`/`document` context by binding via `call`.
  const runInPage = (
    fn: (...args: unknown[]) => unknown,
    arg?: unknown,
  ): unknown => {
    // Shadow our module globals with the JSDOM ones for the duration of the
    // call. `fn` references `document`, `window`, etc. as free variables;
    // because the function was defined in this Node context, those refs
    // resolve to our Node globals — we override them on globalThis for the
    // duration of the call.
    const originals: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(pageGlobals)) {
      originals[k] = (globalThis as Record<string, unknown>)[k];
      (globalThis as Record<string, unknown>)[k] = v;
    }
    // Also expose any installed bridge functions on globalThis so
    // `(window as ...)[bindingName]` lookups inside the evaluator resolve
    // them. We mirror the globalThis onto the JSDOM window.
    for (const [name, fn] of bridges) {
      (window as unknown as Record<string, BridgeFn>)[name] = fn;
    }
    try {
      return arg === undefined ? fn() : fn(arg);
    } finally {
      for (const [k, v] of Object.entries(originals)) {
        if (v === undefined) {
          delete (globalThis as Record<string, unknown>)[k];
        } else {
          (globalThis as Record<string, unknown>)[k] = v;
        }
      }
    }
  };

  const page: Partial<Page> = {
    evaluate: (async (
      fn: (...args: unknown[]) => unknown,
      arg?: unknown,
    ) => {
      return runInPage(fn, arg);
    }) as unknown as Page["evaluate"],
    exposeFunction: (async (name: string, cb: Function) => {
      if (opts.failExposeFunction) {
        throw new Error("exposeFunction disabled for this fake");
      }
      bridges.set(name, cb as BridgeFn);
    }) as Page["exposeFunction"],
    $: (async (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      return {
        click: async () => {
          (el as unknown as { click: () => void }).click();
        },
      } as unknown as Awaited<ReturnType<Page["$"]>>;
    }) as Page["$"],
  };

  const appendMessage: FakePage["appendMessage"] = ({
    id,
    sender,
    text,
    datetime,
    isSelf,
  }) => {
    const list = document.querySelector(
      '[role="list"][aria-label="Chat messages"]',
    );
    if (!list) throw new Error("message list is not mounted");
    const node = document.createElement("div");
    node.setAttribute("role", "listitem");
    node.setAttribute("data-message-id", id);
    if (isSelf) node.setAttribute("data-is-self", "true");
    const senderEl = document.createElement("span");
    senderEl.setAttribute("data-sender-name", "");
    senderEl.textContent = sender;
    const timeEl = document.createElement("time");
    timeEl.setAttribute("datetime", datetime ?? new Date().toISOString());
    timeEl.textContent = "12:00 PM";
    const textEl = document.createElement("p");
    textEl.setAttribute("data-message-text", "");
    textEl.textContent = text;
    node.appendChild(senderEl);
    node.appendChild(timeEl);
    node.appendChild(textEl);
    list.appendChild(node);
  };

  const closePanel: FakePage["closePanel"] = () => {
    const list = document.querySelector(
      '[role="list"][aria-label="Chat messages"]',
    );
    list?.remove();
  };

  return {
    page: page as Page,
    dom,
    document,
    appendMessage,
    closePanel,
    panelToggleClicks: () => toggleClicks,
  };
}

/** Wait for JSDOM's MutationObserver callbacks to flush. */
async function flushMicrotasks(): Promise<void> {
  // JSDOM's MutationObserver runs asynchronously on a microtask; one tick of
  // the event loop is enough to let every pending callback run.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("startChatReader", () => {
  // Keep each test's DOM isolated from the next.
  let reader: { stop: () => Promise<void> } | null = null;

  beforeEach(() => {
    reader = null;
  });

  afterEach(async () => {
    if (reader) {
      await reader.stop();
      reader = null;
    }
  });

  test("emits an InboundChatEvent for pre-existing and newly-appended messages in order", async () => {
    const fake = createFakePage(CHAT_FIXTURE);
    const events: InboundChatEvent[] = [];

    reader = await startChatReader(
      fake.page,
      (event) => {
        events.push(event);
      },
      { meetingId: "meeting-abc", selfName: "Bot" },
    );

    // The fixture ships with one pre-existing message ("Alice: Hello
    // everyone...") — the reader must surface it via the backfill path.
    await flushMicrotasks();
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("chat.inbound");
    expect(events[0]!.meetingId).toBe("meeting-abc");
    expect(events[0]!.fromName).toBe("Alice");
    expect(events[0]!.text).toBe("Hello everyone, welcome to the meeting.");

    // Append a second message via DOM mutation — the observer should pick
    // it up and emit.
    fake.appendMessage({
      id: "msg-002",
      sender: "Bob",
      text: "Good morning.",
      datetime: "2026-04-15T12:35:00Z",
    });
    await flushMicrotasks();

    expect(events.length).toBe(2);
    expect(events[1]!.fromName).toBe("Bob");
    expect(events[1]!.text).toBe("Good morning.");

    // Ordering: Alice before Bob.
    expect(events.map((e) => e.fromName)).toEqual(["Alice", "Bob"]);
  });

  test("drops messages whose sender matches selfName", async () => {
    const fake = createFakePage(CHAT_FIXTURE);
    const events: InboundChatEvent[] = [];

    reader = await startChatReader(
      fake.page,
      (event) => events.push(event),
      { meetingId: "m1", selfName: "Alice" },
    );

    await flushMicrotasks();
    // The fixture's pre-existing message is from "Alice" — since Alice is
    // our self-name, it must be filtered out.
    expect(events.length).toBe(0);

    // A non-self message from Bob should still come through.
    fake.appendMessage({
      id: "msg-002",
      sender: "Bob",
      text: "Hi there.",
    });
    await flushMicrotasks();
    expect(events.length).toBe(1);
    expect(events[0]!.fromName).toBe("Bob");
  });

  test("respects an authoritative data-is-self attribute", async () => {
    const fake = createFakePage(CHAT_FIXTURE);
    const events: InboundChatEvent[] = [];

    reader = await startChatReader(
      fake.page,
      (event) => events.push(event),
      // selfName intentionally doesn't match — we're asserting that the
      // data-is-self hint alone is enough to drop a message.
      { meetingId: "m1", selfName: "SomebodyElse" },
    );

    // Drain the fixture's pre-existing Alice message first.
    await flushMicrotasks();
    events.length = 0;

    fake.appendMessage({
      id: "msg-self",
      sender: "Renamed Bot",
      text: "from the bot",
      isSelf: true,
    });
    await flushMicrotasks();
    expect(events.length).toBe(0);
  });

  test("dedupes identical messages within the 1-second timestamp bucket", async () => {
    const fake = createFakePage(CHAT_FIXTURE);
    const events: InboundChatEvent[] = [];

    reader = await startChatReader(
      fake.page,
      (event) => events.push(event),
      { meetingId: "m1", selfName: "Bot" },
    );

    await flushMicrotasks();
    // Drop the fixture's pre-existing message from the comparison.
    events.length = 0;

    // Two appended messages with the same sender, text, and timestamp but
    // different DOM IDs — bot-side dedupe should collapse them.
    fake.appendMessage({
      id: "msg-dup-a",
      sender: "Bob",
      text: "ping",
      datetime: "2026-04-15T12:36:00Z",
    });
    fake.appendMessage({
      id: "msg-dup-b",
      sender: "Bob",
      text: "ping",
      datetime: "2026-04-15T12:36:00Z",
    });
    await flushMicrotasks();

    expect(events.length).toBe(1);
    expect(events[0]!.fromName).toBe("Bob");
    expect(events[0]!.text).toBe("ping");
  });

  test("clicks the panel toggle when the chat panel is closed", async () => {
    const fake = createFakePage(CHAT_FIXTURE);
    fake.closePanel();
    expect(fake.panelToggleClicks()).toBe(0);

    const events: InboundChatEvent[] = [];
    reader = await startChatReader(
      fake.page,
      (event) => events.push(event),
      { meetingId: "m1", selfName: "Bot" },
    );

    // Exactly one click to open the panel; once open, no further clicks.
    expect(fake.panelToggleClicks()).toBe(1);

    // Now that the panel exists, appending a message should still work end
    // to end.
    fake.appendMessage({
      id: "msg-after-open",
      sender: "Carol",
      text: "hello post-open",
    });
    await flushMicrotasks();
    expect(events.length).toBe(1);
    expect(events[0]!.fromName).toBe("Carol");
  });

  test("does not click the panel toggle when the panel is already open", async () => {
    const fake = createFakePage(CHAT_FIXTURE);

    reader = await startChatReader(
      fake.page,
      () => {},
      { meetingId: "m1", selfName: "Bot" },
    );

    expect(fake.panelToggleClicks()).toBe(0);
  });

  test("stamps meetingId on every event", async () => {
    const fake = createFakePage(CHAT_FIXTURE);
    const events: InboundChatEvent[] = [];

    reader = await startChatReader(
      fake.page,
      (event) => events.push(event),
      { meetingId: "custom-meeting-xyz", selfName: "Bot" },
    );

    await flushMicrotasks();
    fake.appendMessage({
      id: "msg-99",
      sender: "Dave",
      text: "yo",
    });
    await flushMicrotasks();

    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const e of events) {
      expect(e.meetingId).toBe("custom-meeting-xyz");
    }
  });

  test("falls back to polling when exposeFunction fails", async () => {
    const fake = createFakePage(CHAT_FIXTURE, { failExposeFunction: true });
    const events: InboundChatEvent[] = [];

    reader = await startChatReader(
      fake.page,
      (event) => events.push(event),
      { meetingId: "m1", selfName: "Bot" },
    );

    // Polling fires an immediate tick, so the fixture's pre-existing
    // message should surface without waiting an interval.
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 10));
    expect(events.length).toBe(1);
    expect(events[0]!.fromName).toBe("Alice");

    // A newly-appended message surfaces on the next poll (≤ 500ms).
    fake.appendMessage({
      id: "msg-polled",
      sender: "Eve",
      text: "polled hello",
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(events.map((e) => e.fromName)).toContain("Eve");
  });

  test("stop() is idempotent", async () => {
    const fake = createFakePage(CHAT_FIXTURE);
    const events: InboundChatEvent[] = [];

    reader = await startChatReader(
      fake.page,
      (event) => events.push(event),
      { meetingId: "m1", selfName: "Bot" },
    );

    await reader.stop();
    await reader.stop(); // second call must not throw

    // After stop, further DOM mutations should not surface events.
    fake.appendMessage({
      id: "msg-after-stop",
      sender: "Frank",
      text: "post-stop",
    });
    await flushMicrotasks();
    expect(events.map((e) => e.fromName)).not.toContain("Frank");

    // Null out so the afterEach doesn't call stop again.
    reader = null;
  });
});
