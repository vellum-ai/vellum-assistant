/**
 * Unit tests for the content-script `handleSendChat` handler.
 *
 * `handleSendChat` is the path Meet takes when the daemon routes a
 * `meet_send_chat` tool invocation through the extension. We need to
 * confirm it threads an `onEvent` sink + `window` reference through to
 * {@link sendChat} so the runtime tool path emits the same
 * `trusted_type` / `trusted_click` events the consent-post path emits
 * from inside `runJoinFlow`. Without those emits, Meet's `isTrusted`
 * gate silently swallows every post-admission send.
 *
 * `content.ts` runs extension-scoped side effects at import time
 * (`console.log(location.href)` and `chrome.runtime.onMessage.addListener`),
 * so we install a fake `chrome` + JSDOM globals before the dynamic import
 * below. The test then drives the `__handleSendChat` export directly and
 * inspects the `chrome.runtime.sendMessage` call log for the expected
 * event sequence.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
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

interface FakeChrome {
  runtime: {
    sendMessage: (msg: unknown) => void;
    onMessage: {
      addListener: (
        cb: (
          raw: unknown,
          sender: unknown,
          sendResponse: (response?: unknown) => void,
        ) => boolean,
      ) => void;
    };
  };
  /** Log of every frame the handler forwarded to the bot via sendMessage. */
  sent: unknown[];
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
  const chrome: FakeChrome = {
    sent,
    runtime: {
      sendMessage: (msg) => {
        sent.push(msg);
      },
      onMessage: {
        // content.ts calls addListener at module-load time; we just
        // record that it happened by accepting any callback here.
        addListener: () => {},
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

  beforeEach(async () => {
    harness = installHarness();
    // Dynamic import so the content-script side effects (addListener,
    // location.href console.log) execute against the installed harness
    // instead of the bare Bun runtime.
    const mod = (await import("../content.js")) as {
      __handleSendChat: typeof handleSendChat;
    };
    handleSendChat = mod.__handleSendChat;
  });

  afterEach(() => {
    if (harness) {
      harness.restore();
      harness = null;
    }
    handleSendChat = null;
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

    // Composer value must also be populated via the native-setter path so
    // the JS fallback still works for jsdom and any Meet build that does
    // not enforce isTrusted on the composer.
    const input = doc.querySelector<HTMLTextAreaElement>(
      chatSelectors.INPUT,
    )!;
    expect(input.value).toBe("hello from runtime tool");
  });

  test("still forwards send_chat_result(ok=false) when sendChat throws, without emitting trusted events", async () => {
    // Remove the send button so sendChat raises after emitting
    // trusted_type but before emitting trusted_click. We want to confirm
    // the error is captured and a send_chat_result(ok=false) is emitted
    // with the correct requestId and a descriptive error message.
    const doc = harness!.dom.window.document;
    doc
      .querySelector<HTMLButtonElement>(chatSelectors.SEND_BUTTON)
      ?.remove();

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
});
