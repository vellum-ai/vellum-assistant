/**
 * Explicit-send chat loopback E2E test (bot side).
 *
 * End-to-end exercise of the PR 1 `POST /send_chat` HTTP endpoint glued to
 * the real `sendChat` browser helper and the real `startChatReader`. The
 * goal is to catch regressions where:
 *
 *   1. The HTTP handler stops invoking the browser callback.
 *   2. The `sendChat` helper stops driving the DOM correctly (selector
 *      drift, lost form-submit path).
 *   3. The `startChatReader` self-filter stops dropping the bot's own
 *      outbound message and starts echoing it back as an inbound event,
 *      which would create a feedback loop once PR 5's chat-opportunity
 *      detector comes online.
 *
 * The test runs under normal CI: no real Playwright browser is launched,
 * no Chromium binary is downloaded, no network egress. Instead it wires up
 * a JSDOM-backed fake `Page` that implements the small subset of the
 * Playwright surface that `sendChat` and `startChatReader` actually use
 * (waitForSelector / fill / press / click / evaluate / exposeFunction /
 * $), then presses the "submit" path so that a new message node lands in
 * the fixture's message list. That new node simulates the way Meet
 * echoes the bot's outgoing chat back into the in-meeting history — the
 * very signal that would cause a feedback loop without the self-filter.
 *
 * Coverage:
 *   - The `/send_chat` endpoint → `sendChat` → DOM update → `startChatReader`
 *     chain delivers exactly the text posted to the HTTP endpoint.
 *   - The reader filters out the bot's own message (selfName match).
 *   - A follow-up remote message (different sender) still surfaces, so
 *     the self-filter doesn't accidentally muzzle the whole reader after
 *     a send.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

import type { InboundChatEvent } from "@vellumai/meet-contracts";
import type { Page } from "playwright";

import { sendChat } from "../src/browser/chat-bridge.js";
import { startChatReader, type ChatReader } from "../src/browser/chat-reader.js";
import { chatSelectors, selectors } from "../src/browser/dom-selectors.js";
import {
  createHttpServer,
  type HttpServerHandle,
} from "../src/control/http-server.js";
import { BotState } from "../src/control/state.js";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");
const CHAT_FIXTURE = readFileSync(
  join(FIXTURE_DIR, "meet-dom-chat.html"),
  "utf8",
);

const API_TOKEN = "test-loopback-token";
const SELF_NAME = "Loopback Bot";

// ---------------------------------------------------------------------------
// Fake `Page` wiring — shared with the chat-reader unit tests in spirit but
// widened here to also cover the write path (fill / press / click) that
// `sendChat` exercises.
// ---------------------------------------------------------------------------

type BridgeFn = (...args: unknown[]) => unknown;

interface FakePage {
  page: Page;
  dom: JSDOM;
  document: Document;
  /** Append an inbound (non-self) message to the rendered list. */
  appendRemoteMessage: (opts: {
    id: string;
    sender: string;
    text: string;
    datetime?: string;
  }) => void;
  /** Number of times the composer was submitted (Enter pressed or button clicked). */
  submitCount: () => number;
  /** Raw textarea value — exposed so the test can verify what was typed. */
  composerValue: () => string;
}

/**
 * Build a JSDOM-backed Playwright Page stand-in. The fake mirrors just
 * enough of the Page surface for both code paths under test:
 *
 *  - `sendChat` needs `waitForSelector`, `fill`, `press`, `click`.
 *  - `startChatReader` needs `evaluate`, `exposeFunction`, `$`.
 *
 * "Submitting" the composer (Enter or Send click) injects a new message
 * node into the rendered chat list with the bot's display name attached
 * via `data-sender-name`, exactly the way Meet renders the bot's own
 * outgoing message back into the history panel. That is the signal the
 * chat reader must drop.
 */
function createFakePage(html: string, selfName: string): FakePage {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const window = dom.window;
  const document = window.document;

  // Ensure the messages container exists in the fixture — we rely on it
  // being mounted so the submit path can append into it deterministically.
  const messagesList = document.querySelector(
    '[role="list"][aria-label="Chat messages"]',
  );
  if (!messagesList) {
    throw new Error(
      "Expected the chat fixture to mount [role='list'][aria-label='Chat messages'].",
    );
  }

  // Bridges installed via `exposeFunction`, keyed by binding name.
  const bridges = new Map<string, BridgeFn>();

  // Per-submit counter, bumped by the Enter-press and Send-button paths.
  let submitCount = 0;
  let outgoingMessageCounter = 0;

  const performSubmit = (): void => {
    const textarea = document.querySelector(
      chatSelectors.INPUT,
    ) as unknown as HTMLTextAreaElement | null;
    if (!textarea) return;
    const text = textarea.value;
    textarea.value = "";
    if (!text) return;
    submitCount += 1;
    outgoingMessageCounter += 1;
    // Simulate Meet echoing the bot's own outgoing message back into the
    // in-call history. `data-sender-name` matches the reader's
    // MESSAGE_SENDER selector so the reader sees the same "from Bot"
    // attribution Meet produces, giving the self-filter something real to
    // fire against. Note: we intentionally don't set `data-is-self` —
    // this keeps the filter honest (must match by display name).
    const node = document.createElement("div");
    node.setAttribute("role", "listitem");
    node.setAttribute("data-message-id", `bot-out-${outgoingMessageCounter}`);
    const senderEl = document.createElement("span");
    senderEl.setAttribute("data-sender-name", "");
    senderEl.textContent = selfName;
    const timeEl = document.createElement("time");
    timeEl.setAttribute("datetime", new Date().toISOString());
    timeEl.textContent = "12:00 PM";
    const textEl = document.createElement("p");
    textEl.setAttribute("data-message-text", "");
    textEl.textContent = text;
    node.appendChild(senderEl);
    node.appendChild(timeEl);
    node.appendChild(textEl);
    messagesList.appendChild(node);
  };

  // -------------------------------------------------------------------------
  // `evaluate` shim (shared with chat-reader's fake) — runs the caller's
  // function with JSDOM's document/window/MutationObserver globals bound
  // onto globalThis for the duration of the call. Same strategy as
  // `chat-reader.test.ts`.
  // -------------------------------------------------------------------------

  const pageGlobals = {
    document,
    window,
    MutationObserver: window.MutationObserver,
    Date,
    Number,
    Array,
    Set,
  } as Record<string, unknown>;

  const runInPage = (
    fn: (...args: unknown[]) => unknown,
    arg?: unknown,
  ): unknown => {
    const originals: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(pageGlobals)) {
      originals[k] = (globalThis as Record<string, unknown>)[k];
      (globalThis as Record<string, unknown>)[k] = v;
    }
    // Expose installed `exposeFunction` bridges on the JSDOM window so the
    // in-page evaluator finds them when it does `(window as ...)[name]`.
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

  // -------------------------------------------------------------------------
  // Write-path shims — what `sendChat` drives.
  // -------------------------------------------------------------------------

  const waitForSelector: Page["waitForSelector"] = (async (
    selector: string,
  ) => {
    const el = document.querySelector(selector);
    if (!el) {
      throw new Error(`waitForSelector: ${selector} not found`);
    }
    return el as unknown as Awaited<ReturnType<Page["waitForSelector"]>>;
  }) as Page["waitForSelector"];

  const fill: Page["fill"] = (async (selector: string, value: string) => {
    const el = document.querySelector(selector) as unknown as
      | (HTMLTextAreaElement & { value: string })
      | null;
    if (!el) throw new Error(`fill: ${selector} not found`);
    el.value = value;
  }) as Page["fill"];

  const press: Page["press"] = (async (selector: string, key: string) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`press: ${selector} not found`);
    if (key === "Enter") {
      performSubmit();
    }
  }) as Page["press"];

  const click: Page["click"] = (async (selector: string) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`click: ${selector} not found`);
    if (selector === chatSelectors.SEND_BUTTON) {
      performSubmit();
    } else {
      (el as unknown as { click: () => void }).click();
    }
  }) as Page["click"];

  const page: Partial<Page> = {
    waitForSelector,
    fill,
    press,
    click,
    evaluate: (async (
      fn: (...args: unknown[]) => unknown,
      arg?: unknown,
    ) => {
      return runInPage(fn, arg);
    }) as unknown as Page["evaluate"],
    exposeFunction: (async (name: string, cb: Function) => {
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

  const appendRemoteMessage: FakePage["appendRemoteMessage"] = ({
    id,
    sender,
    text,
    datetime,
  }) => {
    const node = document.createElement("div");
    node.setAttribute("role", "listitem");
    node.setAttribute("data-message-id", id);
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
    messagesList.appendChild(node);
  };

  return {
    page: page as Page,
    dom,
    document,
    appendRemoteMessage,
    submitCount: () => submitCount,
    composerValue: () => {
      const textarea = document.querySelector(
        chatSelectors.INPUT,
      ) as unknown as HTMLTextAreaElement | null;
      return textarea?.value ?? "";
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function startOnRandomPort(
  server: HttpServerHandle,
): Promise<string> {
  const { port } = await server.start(0);
  return `http://127.0.0.1:${port}`;
}

async function postSendChat(
  base: string,
  text: string,
): Promise<Response> {
  return fetch(`${base}/send_chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ type: "send_chat", text }),
  });
}

/**
 * Yield back to the event loop so JSDOM's async MutationObserver queue
 * flushes. Same helper shape as `chat-reader.test.ts`.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("chat loopback: /send_chat → DOM → startChatReader", () => {
  let server: HttpServerHandle | null = null;
  let reader: ChatReader | null = null;

  beforeEach(() => {
    BotState.__resetForTests();
  });

  afterEach(async () => {
    if (reader) {
      await reader.stop();
      reader = null;
    }
    if (server !== null) {
      await server.stop();
      server = null;
    }
  });

  test(
    "POST /send_chat drives sendChat, the chat reader observes the DOM change, and the bot's self-send is filtered out",
    async () => {
      const fake = createFakePage(CHAT_FIXTURE, SELF_NAME);

      // 1. Stand up the chat reader first so the in-page MutationObserver
      //    is live before we POST. This mirrors the production wiring in
      //    `main.ts` — the reader starts during step 5 of `runBot`, well
      //    before the HTTP control surface accepts requests.
      const inboundEvents: InboundChatEvent[] = [];
      reader = await startChatReader(
        fake.page,
        (event) => {
          inboundEvents.push(event);
        },
        { meetingId: "meeting-loopback", selfName: SELF_NAME },
      );

      // Drain the fixture's pre-existing "Alice: Hello everyone..." so the
      // assertion below only reflects post-send traffic. (That message is
      // NOT a self-send; it's an inbound event.)
      await flushMicrotasks();
      expect(inboundEvents).toHaveLength(1);
      expect(inboundEvents[0]!.fromName).toBe("Alice");
      inboundEvents.length = 0;

      // 2. Bring up the HTTP server with `onSendChat` wired to the real
      //    `sendChat` helper, exactly like `main.ts` does.
      server = createHttpServer({
        apiToken: API_TOKEN,
        onLeave: () => {},
        onSendChat: async (text) => {
          await sendChat(fake.page, text);
        },
        onPlayAudio: () => {},
      });
      const base = await startOnRandomPort(server);

      // 3. POST the chat message.
      const sentText = "Hello from the loopback test.";
      const res = await postSendChat(base, sentText);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sent: boolean;
        timestamp: string;
      };
      expect(body.sent).toBe(true);

      // sendChat should have filled the composer, pressed Enter, and the
      // fake's submit handler should have cleared the field.
      expect(fake.submitCount()).toBe(1);
      expect(fake.composerValue()).toBe("");

      // The submitted message node should now be in the DOM.
      const messageNodes = fake.document.querySelectorAll(
        selectors.INGAME_CHAT_MESSAGE_NODE,
      );
      expect(messageNodes.length).toBeGreaterThanOrEqual(2);
      const botNode = Array.from(messageNodes).find(
        (n) => n.getAttribute("data-message-id") === "bot-out-1",
      );
      expect(botNode).toBeDefined();
      const botText = botNode
        ?.querySelector(selectors.INGAME_CHAT_MESSAGE_TEXT)
        ?.textContent?.trim();
      expect(botText).toBe(sentText);

      // 4. Give the MutationObserver a tick to process the newly-appended
      //    node and invoke the bridge.
      await flushMicrotasks();

      // 5. **The critical assertion**: the bot's own outgoing message
      //    MUST NOT appear as an InboundChatEvent. `startChatReader`'s
      //    self-filter matches by display name (selfName === SELF_NAME
      //    === the message's rendered sender), so the bridge call is
      //    dropped before `onMessage` fires.
      expect(inboundEvents).toHaveLength(0);

      // 6. Sanity check: a remote (non-self) message still surfaces after
      //    the self-send, so the filter didn't over-aggressively mute the
      //    entire reader.
      fake.appendRemoteMessage({
        id: "remote-after-send",
        sender: "Bob",
        text: "Got it, thanks.",
      });
      await flushMicrotasks();
      expect(inboundEvents).toHaveLength(1);
      expect(inboundEvents[0]!.fromName).toBe("Bob");
      expect(inboundEvents[0]!.text).toBe("Got it, thanks.");
    },
  );

  test(
    "multiple consecutive sends each round-trip through the chat reader without leaking a self-echo",
    async () => {
      // This guards against a subtle class of bug: if the self-filter
      // bucketed by sender+text+timestamp only (the dedupe key), a
      // second bot-send with the same text but a different timestamp
      // might slip through. We send twice with different text and
      // assert zero inbound events either way.
      const fake = createFakePage(CHAT_FIXTURE, SELF_NAME);

      const inboundEvents: InboundChatEvent[] = [];
      reader = await startChatReader(
        fake.page,
        (event) => inboundEvents.push(event),
        { meetingId: "meeting-loopback-2", selfName: SELF_NAME },
      );
      await flushMicrotasks();
      inboundEvents.length = 0; // drop the fixture's "Alice: Hello..." backfill

      server = createHttpServer({
        apiToken: API_TOKEN,
        onLeave: () => {},
        onSendChat: async (text) => {
          await sendChat(fake.page, text);
        },
        onPlayAudio: () => {},
      });
      const base = await startOnRandomPort(server);

      // First send.
      let res = await postSendChat(base, "first send");
      expect(res.status).toBe(200);
      await flushMicrotasks();

      // Second send — distinct text so the bot-side dedupe key is
      // unambiguously different from the first.
      res = await postSendChat(base, "second send");
      expect(res.status).toBe(200);
      await flushMicrotasks();

      expect(fake.submitCount()).toBe(2);
      // Still zero inbound events — both self-sends dropped.
      expect(inboundEvents).toHaveLength(0);
    },
  );
});
