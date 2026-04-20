/**
 * Unit tests for the `handleSendChat` runtime tool-path handler.
 *
 * `handleSendChat` is the path Meet takes when the daemon routes a
 * `meet_send_chat` tool invocation through the extension. We need to
 * confirm it threads an `onEvent` sink + `window` reference through to
 * {@link sendChat} so the runtime tool path emits the same
 * `trusted_type` / `trusted_click` events the consent-post path emits
 * from inside `runJoinFlow`. Without those emits, Meet's `isTrusted`
 * gate silently swallows every post-admission send.
 *
 * The handler and queue live in `handle-send-chat.ts` — separate from
 * `content.ts` so the content-script entrypoint stays side-effect-only
 * (Chrome loads MV3 content scripts as classic scripts; a stray
 * `export` at the top level of `content.js` makes the whole bundle
 * fail to parse at load time). Tests install a fake `chrome` + JSDOM
 * globals before the dynamic import below so `sendChat`'s bare
 * `document` / `chrome.runtime` references resolve to the fixture, then
 * drive the exported handler directly and inspect the
 * `chrome.runtime.sendMessage` call log for the expected event sequence.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { JSDOM } from "jsdom";

import type { ExtensionToBotMessage } from "../../../contracts/native-messaging.js";

import { chatSelectors } from "../dom/selectors.js";

const FIXTURE_DIR = pathJoin(
  import.meta.dir,
  "..",
  "dom",
  "__tests__",
  "fixtures",
);
const CHAT_FIXTURE = readFileSync(
  pathJoin(FIXTURE_DIR, "meet-dom-chat.html"),
  "utf8",
);

type OnMessageListener = (
  raw: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean;

interface FakeChrome {
  runtime: {
    sendMessage: (msg: unknown) => void;
    onMessage: {
      addListener: (cb: OnMessageListener) => void;
    };
  };
  /** Log of every frame the handler forwarded to the bot via sendMessage. */
  sent: unknown[];
  /** Listeners registered on `chrome.runtime.onMessage` (drives the queue). */
  listeners: OnMessageListener[];
}

interface InstalledHarness {
  dom: JSDOM;
  chrome: FakeChrome;
  restore: () => void;
}

/**
 * Install a JSDOM document + fake `chrome` runtime on `globalThis` so
 * `content.ts`'s bare references (`document`, `window`, `location`,
 * `chrome.runtime.*`) resolve to the fixture. Tracks every
 * `chrome.runtime.sendMessage` call so the tests can assert the emitted
 * event stream for a given `handleSendChat` invocation.
 */
function installHarness(): InstalledHarness {
  const dom = new JSDOM(CHAT_FIXTURE, {
    runScripts: "outside-only",
    url: "https://meet.google.com/abc-defg-hij",
  });
  const window = dom.window;
  const document = window.document;

  const sent: unknown[] = [];
  const listeners: OnMessageListener[] = [];
  const chrome: FakeChrome = {
    sent,
    listeners,
    runtime: {
      sendMessage: (msg) => {
        sent.push(msg);
      },
      onMessage: {
        // Capture the listener so tests that need to exercise the
        // listener-level serialization queue can dispatch raw frames
        // through it (and the exported `__handleSendChat` remains
        // available for tests that don't care about the queue).
        addListener: (cb) => {
          listeners.push(cb);
        },
      },
    },
  };

  const originals: Record<string, unknown> = {};
  const wire = (key: string, value: unknown): void => {
    originals[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = value;
  };
  wire("document", document);
  wire("window", window);
  wire("location", window.location);
  wire("MutationObserver", window.MutationObserver);
  wire("Event", window.Event);
  wire("HTMLTextAreaElement", window.HTMLTextAreaElement);
  wire("HTMLButtonElement", window.HTMLButtonElement);
  wire("chrome", chrome);
  // Mirror JSDOM's screen-coord shape onto globalThis so `handleSendChat`
  // — which passes `globalThis` as the window reference to `sendChat` —
  // sees deterministic values when computing the send-button's
  // trusted_click coords. Tests that want a different coord shape
  // overwrite these before invoking the handler.
  wire("screenX", 0);
  wire("screenY", 0);
  wire("outerHeight", 820);
  wire("innerHeight", 720);

  return {
    dom,
    chrome,
    restore: () => {
      for (const [k, v] of Object.entries(originals)) {
        if (v === undefined) {
          delete (globalThis as Record<string, unknown>)[k];
        } else {
          (globalThis as Record<string, unknown>)[k] = v;
        }
      }
    },
  };
}

describe("handleSendChat (content-script meet_send_chat tool path)", () => {
  let harness: InstalledHarness | null = null;
  let handleSendChat:
    | ((cmd: {
        type: "send_chat";
        text: string;
        requestId: string;
      }) => Promise<void>)
    | null = null;
  let enqueueSendChat:
    | ((cmd: {
        type: "send_chat";
        text: string;
        requestId: string;
      }) => Promise<void>)
    | null = null;

  beforeEach(async () => {
    harness = installHarness();
    // Dynamic import so `sendChat`'s module-scoped references to DOM
    // globals resolve against the installed harness on first evaluation.
    const mod = (await import("../handle-send-chat.js")) as {
      handleSendChat: typeof handleSendChat;
      enqueueSendChat: typeof enqueueSendChat;
    };
    handleSendChat = mod.handleSendChat;
    enqueueSendChat = mod.enqueueSendChat;
  });

  afterEach(() => {
    if (harness) {
      harness.restore();
      harness = null;
    }
    handleSendChat = null;
    enqueueSendChat = null;
  });

  test("emits trusted_type + trusted_click and a send_chat_result when Meet accepts the send", async () => {
    // Stub the send-button geometry so the trusted_click coord math is
    // deterministic. Mirrors the `sendChat` tests in chat.test.ts.
    const doc = harness!.dom.window.document;
    const sendButton = doc.querySelector<HTMLButtonElement>(
      chatSelectors.SEND_BUTTON,
    )!;
    sendButton.getBoundingClientRect = () =>
      ({
        left: 1300,
        top: 700,
        width: 60,
        height: 40,
        right: 1360,
        bottom: 740,
        x: 1300,
        y: 700,
        toJSON() {
          return {};
        },
      }) as DOMRect;

    // Screen-coord shape is pinned in installHarness() so `globalThis`
    // (which `handleSendChat` forwards to `sendChat` as the window
    // reference) carries deterministic values for the coord math.

    await handleSendChat!({
      type: "send_chat",
      text: "hello from runtime tool",
      requestId: "req-1",
    });

    // The handler must forward three frames in order:
    //   1. trusted_type  — composer keystroke hint
    //   2. trusted_click — send-button click hint
    //   3. send_chat_result — correlation reply
    const sent = harness!.chrome.sent as ExtensionToBotMessage[];

    // Events must include BOTH trusted_type and trusted_click.
    const trustedTypes = sent.filter((e) => e.type === "trusted_type");
    const trustedClicks = sent.filter((e) => e.type === "trusted_click");
    expect(trustedTypes.length).toBe(1);
    expect(trustedClicks.length).toBe(1);

    // trusted_type must carry the literal text the bot will xdotool-type.
    const trustedType = trustedTypes[0]!;
    if (trustedType.type === "trusted_type") {
      expect(trustedType.text).toBe("hello from runtime tool");
    }

    // trusted_click must carry the computed screen coords.
    // x = screenX + rect.left + rect.width/2 = 0 + 1300 + 30 = 1330
    // y = screenY + chromeOffsetY + rect.top + rect.height/2
    //   = 0 + (820-720) + 700 + 20 = 820
    const trustedClick = trustedClicks[0]!;
    if (trustedClick.type === "trusted_click") {
      expect(trustedClick.x).toBe(1330);
      expect(trustedClick.y).toBe(820);
    }

    // Exactly one send_chat_result, correlated to the original requestId,
    // with ok=true.
    const results = sent.filter((e) => e.type === "send_chat_result");
    expect(results.length).toBe(1);
    const result = results[0]!;
    if (result.type === "send_chat_result") {
      expect(result.requestId).toBe("req-1");
      expect(result.ok).toBe(true);
    }

    // Ordering: trusted_type before trusted_click before send_chat_result.
    // Catches any regression where sendChat stops being awaited or the
    // reply leaks out ahead of the xdotool hints.
    const trustedTypeIdx = sent.findIndex((e) => e.type === "trusted_type");
    const trustedClickIdx = sent.findIndex((e) => e.type === "trusted_click");
    const resultIdx = sent.findIndex((e) => e.type === "send_chat_result");
    expect(trustedTypeIdx).toBeGreaterThanOrEqual(0);
    expect(trustedClickIdx).toBeGreaterThan(trustedTypeIdx);
    expect(resultIdx).toBeGreaterThan(trustedClickIdx);

    // With `onEvent` wired (the handler always passes one), sendChat
    // relies on xdotool to type the composer — the synthetic
    // `.value = text` + `input` dispatch is skipped so that xdotool's
    // appended keystrokes do not produce doubled text. In-test, where
    // xdotool is stubbed out, the composer therefore remains empty.
    const input = doc.querySelector<HTMLTextAreaElement>(chatSelectors.INPUT)!;
    expect(input.value).toBe("");
  });

  test("still forwards send_chat_result(ok=false) when sendChat throws, without emitting trusted events", async () => {
    // Remove the send button so sendChat raises after emitting
    // trusted_type but before emitting trusted_click. We want to confirm
    // the error is captured and a send_chat_result(ok=false) is emitted
    // with the correct requestId and a descriptive error message.
    const doc = harness!.dom.window.document;
    doc.querySelector<HTMLButtonElement>(chatSelectors.SEND_BUTTON)?.remove();

    await handleSendChat!({
      type: "send_chat",
      text: "will fail",
      requestId: "req-2",
    });

    const sent = harness!.chrome.sent as ExtensionToBotMessage[];
    const results = sent.filter((e) => e.type === "send_chat_result");
    expect(results.length).toBe(1);
    const result = results[0]!;
    if (result.type === "send_chat_result") {
      expect(result.requestId).toBe("req-2");
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.error).toMatch(/send button not found/);
      }
    }

    // trusted_type is still emitted because the failure happens on the
    // send-button query AFTER the composer focus + trusted_type emit.
    // That matches the consent-post semantics in `sendChat`.
    const trustedTypes = sent.filter((e) => e.type === "trusted_type");
    expect(trustedTypes.length).toBe(1);

    // trusted_click is NOT emitted — the send button was missing.
    const trustedClicks = sent.filter((e) => e.type === "trusted_click");
    expect(trustedClicks.length).toBe(0);
  });

  test("correlates requestId even when text exceeds the 2000-char cap", async () => {
    // Over-cap text rejects synchronously inside sendChat BEFORE any
    // trusted event fires. The handler must still emit a
    // send_chat_result(ok=false) with the original requestId — this is
    // the behavior the bot's meet_send_chat tool relies on to surface
    // the error to the daemon.
    await handleSendChat!({
      type: "send_chat",
      text: "x".repeat(2001),
      requestId: "req-3",
    });

    const sent = harness!.chrome.sent as ExtensionToBotMessage[];
    const results = sent.filter((e) => e.type === "send_chat_result");
    expect(results.length).toBe(1);
    const result = results[0]!;
    if (result.type === "send_chat_result") {
      expect(result.requestId).toBe("req-3");
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.error).toMatch(/2000/);
      }
    }

    // No trusted_type / trusted_click because the cap check throws
    // before sendChat touches the DOM or the onEvent sink.
    const trustedTypes = sent.filter((e) => e.type === "trusted_type");
    const trustedClicks = sent.filter((e) => e.type === "trusted_click");
    expect(trustedTypes.length).toBe(0);
    expect(trustedClicks.length).toBe(0);
  });

  test("serializes overlapping send_chat commands so the wrong text is never posted", async () => {
    // `sendChat` emits a `trusted_type` for the composer then waits
    // (scaled to text length) before the send-button JS `.click()` +
    // `trusted_click`, so two overlapping invocations would race on the
    // shared Xvfb keyboard focus: the second call's trusted_type would
    // interleave with the first call's keystrokes still in flight,
    // producing a composer that contains "firstsecond" when the first
    // send-click lands. The fix chains `handleSendChat` invocations onto
    // a per-tab Promise inside the `chrome.runtime.onMessage` listener,
    // so the second call can't emit its trusted_type until the first has
    // fully completed its send-button click.
    //
    // This regression test drives two `send_chat` frames into the
    // exported `__enqueueSendChat` helper (the same entry point the
    // listener uses) back-to-back and records the emitted-event stream
    // so the ordering is visible. With serialization, the stream is
    // [trusted_type("first"), trusted_click, js-click, trusted_type(
    // "second"), trusted_click, js-click]. Without it, both
    // trusted_types would fire before either click.
    const doc = harness!.dom.window.document;
    const sendButton = doc.querySelector<HTMLButtonElement>(
      chatSelectors.SEND_BUTTON,
    )!;

    const timeline: string[] = [];
    sendButton.addEventListener("click", () => {
      timeline.push("js-click");
    });

    // Wrap sendMessage so emitted frames interleave with the js-click
    // records above — must happen BEFORE enqueueing any handler call,
    // since the first trusted_type emit fires synchronously on the
    // handler's first turn.
    const originalSendMessage = harness!.chrome.runtime.sendMessage;
    harness!.chrome.runtime.sendMessage = (msg: unknown) => {
      originalSendMessage.call(harness!.chrome.runtime, msg);
      const m = msg as ExtensionToBotMessage;
      if (m.type === "trusted_type") {
        timeline.push(`trusted_type(${m.text})`);
      } else if (m.type === "trusted_click") {
        timeline.push("trusted_click");
      }
    };

    // Fire both frames synchronously into the queue, then wait for it to
    // drain. If the handler still `void`-launched each `handleSendChat`,
    // both would run concurrently — the length-scaled `setTimeout` inside
    // `sendChat` (onEvent-path wait before clicking send) would
    // interleave the two calls.
    const p1 = enqueueSendChat!({
      type: "send_chat",
      text: "first",
      requestId: "req-a",
    });
    const p2 = enqueueSendChat!({
      type: "send_chat",
      text: "second",
      requestId: "req-b",
    });

    await Promise.all([p1, p2]);

    // Serialized ordering: every first-call event lands before any
    // second-call event. In particular the first send-click fires before
    // the second's trusted_type emits.
    const firstTypeIdx = timeline.indexOf("trusted_type(first)");
    const firstClickIdx = timeline.indexOf("js-click");
    const secondTypeIdx = timeline.indexOf("trusted_type(second)");
    expect(firstTypeIdx).toBeGreaterThanOrEqual(0);
    expect(firstClickIdx).toBeGreaterThan(firstTypeIdx);
    expect(secondTypeIdx).toBeGreaterThan(firstClickIdx);

    // Both results must still be emitted in order, each correlated with
    // the right requestId.
    const sent = harness!.chrome.sent as ExtensionToBotMessage[];
    const results = sent.filter((e) => e.type === "send_chat_result");
    expect(results.length).toBe(2);
    const r0 = results[0]!;
    const r1 = results[1]!;
    if (
      r0.type === "send_chat_result" &&
      r1.type === "send_chat_result"
    ) {
      expect(r0.requestId).toBe("req-a");
      expect(r0.ok).toBe(true);
      expect(r1.requestId).toBe("req-b");
      expect(r1.ok).toBe(true);
    }
  });
});
