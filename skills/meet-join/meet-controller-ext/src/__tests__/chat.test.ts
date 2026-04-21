/**
 * Unit tests for `src/features/chat.ts` — jsdom-only.
 *
 * The content-script version of the chat reader/sender operates directly on
 * `document` rather than going through Playwright, so we can exercise it end
 * to end by installing a JSDOM document as the process-wide `document` /
 * `window` pair before each test. JSDOM provides a real MutationObserver, so
 * DOM mutations fire through the observer just as they would inside Meet.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

import type { ExtensionToBotMessage } from "../../../contracts/native-messaging.js";

import { chatSelectors } from "../dom/selectors.js";
import {
  MEET_CHAT_MAX_LENGTH,
  postConsentMessage,
  sendChat,
  startChatReader,
} from "../features/chat.js";

const FIXTURE_DIR = join(import.meta.dir, "..", "dom", "__tests__", "fixtures");
const CHAT_FIXTURE = readFileSync(
  join(FIXTURE_DIR, "meet-dom-chat.html"),
  "utf8",
);

interface InstalledDom {
  dom: JSDOM;
  /** Count of times the chat panel toggle button was clicked. */
  panelToggleClicks: () => number;
  /** Remove the message list so ensurePanelOpen takes the click path. */
  closePanel: () => void;
  /** Append a rendered message <div> to the chat list. */
  appendMessage: (opts: {
    id: string;
    sender: string;
    text: string;
    datetime?: string;
    isSelf?: boolean;
  }) => void;
  /**
   * Register a callback that fires synchronously after the toggle-click
   * handler has mounted (or remounted) the panel elements (list,
   * composer, send button). Tests use this to attach click listeners or
   * stub `getBoundingClientRect` on elements that only exist after the
   * panel opens.
   */
  onPanelOpen: (fn: () => void) => void;
}

/**
 * Install a JSDOM document on `globalThis` so `chat.ts`'s bare `document` /
 * `window` references resolve to the fixture. Also injects the panel toggle
 * button (the chat fixture alone doesn't carry it — it lives in the in-game
 * fixture) so `ensurePanelOpen` has something to click.
 */
function installChatDom(): InstalledDom {
  const dom = new JSDOM(CHAT_FIXTURE, { runScripts: "outside-only" });
  const window = dom.window;
  const document = window.document;

  // The chat fixture doesn't include the toolbar panel toggle; inject one so
  // `ensurePanelOpen`'s click path has a target.
  if (!document.querySelector(chatSelectors.PANEL_BUTTON)) {
    const toggle = document.createElement("button");
    toggle.setAttribute("type", "button");
    toggle.setAttribute("aria-label", "Chat with everyone");
    toggle.textContent = "Chat";
    document.body.appendChild(toggle);
  }

  let toggleClicks = 0;
  const onPanelOpenCallbacks: Array<() => void> = [];
  const attachToggleHandler = (): void => {
    const toggle = document.querySelector(chatSelectors.PANEL_BUTTON);
    if (!toggle) return;
    toggle.addEventListener("click", () => {
      toggleClicks += 1;
      const aside = document.querySelector("aside");
      // Remount the whole chat surface (list + composer + send button)
      // together. In production Meet, closing the panel tears all three
      // down at once and reopening it mounts them together. Keeping the
      // fixture in sync with that invariant is what lets
      // `ensurePanelOpen`'s new composer-anchored short-circuit behave
      // the same way in tests as it does against real Meet.
      if (!document.querySelector(chatSelectors.MESSAGE_LIST)) {
        const list = document.createElement("div");
        list.setAttribute("role", "list");
        list.setAttribute("aria-label", "Chat messages");
        aside?.insertBefore(list, aside.firstChild);
      }
      if (!document.querySelector(chatSelectors.INPUT)) {
        const input = document.createElement("textarea");
        input.setAttribute("aria-label", "Send a message");
        aside?.appendChild(input);
      }
      if (!document.querySelector(chatSelectors.SEND_BUTTON)) {
        const sendButton = document.createElement("button");
        sendButton.setAttribute("type", "button");
        sendButton.setAttribute("aria-label", "Send a message");
        sendButton.textContent = "Send";
        aside?.appendChild(sendButton);
      }
      // Run any post-mount hooks the test registered. Tests use this to
      // attach click listeners or stub geometry on the freshly-mounted
      // composer / send button before `sendChat` queries them.
      for (const fn of onPanelOpenCallbacks) {
        fn();
      }
    });
  };
  attachToggleHandler();

  // Swap the process-wide globals that `chat.ts` closes over. Keep
  // originals so `restore()` can put them back.
  const originals: Record<string, unknown> = {};
  const wire = (key: string, value: unknown): void => {
    originals[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = value;
  };
  wire("document", document);
  wire("window", window);
  wire("MutationObserver", window.MutationObserver);
  wire("Event", window.Event);
  wire("HTMLTextAreaElement", window.HTMLTextAreaElement);
  wire("HTMLButtonElement", window.HTMLButtonElement);

  const appendMessage: InstalledDom["appendMessage"] = ({
    id,
    sender,
    text,
    datetime,
    isSelf,
  }) => {
    const list = document.querySelector(chatSelectors.MESSAGE_LIST);
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

  const closePanel: InstalledDom["closePanel"] = () => {
    // Production Meet tears down the whole chat surface when the panel
    // closes — list, composer, and send button all go away together.
    // Removing only the list would leave `ensurePanelOpen`'s composer-
    // anchored short-circuit incorrectly satisfied and skip the toggle
    // click the callers are validating.
    document.querySelector(chatSelectors.MESSAGE_LIST)?.remove();
    document.querySelector(chatSelectors.INPUT)?.remove();
    document.querySelector(chatSelectors.SEND_BUTTON)?.remove();
  };

  // Restore original globals on teardown. Stored on the JSDOM instance so
  // `afterEach` can fish them back out.
  (dom as unknown as { __restore: () => void }).__restore = () => {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) {
        delete (globalThis as Record<string, unknown>)[k];
      } else {
        (globalThis as Record<string, unknown>)[k] = v;
      }
    }
  };

  return {
    dom,
    panelToggleClicks: () => toggleClicks,
    closePanel,
    appendMessage,
    onPanelOpen: (fn: () => void): void => {
      onPanelOpenCallbacks.push(fn);
    },
  };
}

/** Wait for JSDOM's MutationObserver callbacks to flush. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("startChatReader", () => {
  let reader: { stop: () => void } | null = null;
  let installed: InstalledDom | null = null;

  beforeEach(() => {
    reader = null;
    installed = installChatDom();
  });

  afterEach(() => {
    if (reader) {
      reader.stop();
      reader = null;
    }
    if (installed) {
      (installed.dom as unknown as { __restore: () => void }).__restore();
      installed = null;
    }
  });

  test("emits chat.inbound for pre-existing and newly-appended messages in order", async () => {
    const events: ExtensionToBotMessage[] = [];
    reader = startChatReader({
      meetingId: "meeting-abc",
      selfName: "Bot",
      onEvent: (ev) => events.push(ev),
    });

    // Fixture ships with one pre-existing message from Alice — the backfill
    // path should surface it synchronously.
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("chat.inbound");
    const first = events[0] as Extract<
      ExtensionToBotMessage,
      { type: "chat.inbound" }
    >;
    expect(first.meetingId).toBe("meeting-abc");
    expect(first.fromName).toBe("Alice");
    expect(first.text).toBe("Hello everyone, welcome to the meeting.");

    installed!.appendMessage({
      id: "msg-002",
      sender: "Bob",
      text: "Good morning.",
      datetime: "2026-04-15T12:35:00Z",
    });
    await flushMicrotasks();

    expect(events.length).toBe(2);
    const second = events[1] as Extract<
      ExtensionToBotMessage,
      { type: "chat.inbound" }
    >;
    expect(second.fromName).toBe("Bob");
    expect(second.text).toBe("Good morning.");

    expect(
      events.map(
        (e) =>
          (e as Extract<ExtensionToBotMessage, { type: "chat.inbound" }>)
            .fromName,
      ),
    ).toEqual(["Alice", "Bob"]);
  });

  test("drops messages whose sender matches selfName", async () => {
    const events: ExtensionToBotMessage[] = [];
    reader = startChatReader({
      meetingId: "m1",
      selfName: "Alice",
      onEvent: (ev) => events.push(ev),
    });

    // The fixture's pre-existing message is from "Alice" — since Alice is
    // our self-name, it must be filtered out.
    expect(events.length).toBe(0);

    installed!.appendMessage({
      id: "msg-002",
      sender: "Bob",
      text: "Hi there.",
    });
    await flushMicrotasks();
    expect(events.length).toBe(1);
    const ev = events[0] as Extract<
      ExtensionToBotMessage,
      { type: "chat.inbound" }
    >;
    expect(ev.fromName).toBe("Bob");
  });

  test("respects an authoritative data-is-self attribute", async () => {
    const events: ExtensionToBotMessage[] = [];
    reader = startChatReader({
      meetingId: "m1",
      // Intentional mismatch — we're asserting the attribute alone drops
      // the message.
      selfName: "SomebodyElse",
      onEvent: (ev) => events.push(ev),
    });

    // Drain the fixture's pre-existing Alice message first.
    events.length = 0;

    installed!.appendMessage({
      id: "msg-self",
      sender: "Renamed Bot",
      text: "from the bot",
      isSelf: true,
    });
    await flushMicrotasks();
    expect(events.length).toBe(0);
  });

  test("dedupes messages with the same domId", async () => {
    const events: ExtensionToBotMessage[] = [];
    reader = startChatReader({
      meetingId: "m1",
      selfName: "Bot",
      onEvent: (ev) => events.push(ev),
    });

    // Drop the fixture's pre-existing message from the comparison.
    events.length = 0;

    installed!.appendMessage({
      id: "msg-dup",
      sender: "Bob",
      text: "ping",
      datetime: "2026-04-15T12:36:00Z",
    });
    installed!.appendMessage({
      id: "msg-dup",
      sender: "Bob",
      text: "ping",
      datetime: "2026-04-15T12:36:00Z",
    });
    await flushMicrotasks();

    expect(events.length).toBe(1);
    const ev = events[0] as Extract<
      ExtensionToBotMessage,
      { type: "chat.inbound" }
    >;
    expect(ev.fromName).toBe("Bob");
    expect(ev.text).toBe("ping");
  });

  test("clicks the panel toggle when the chat panel is closed", async () => {
    installed!.closePanel();
    expect(installed!.panelToggleClicks()).toBe(0);

    const events: ExtensionToBotMessage[] = [];
    reader = startChatReader({
      meetingId: "m1",
      selfName: "Bot",
      onEvent: (ev) => events.push(ev),
    });

    // Exactly one click to open the panel; once open, no further clicks.
    expect(installed!.panelToggleClicks()).toBe(1);

    installed!.appendMessage({
      id: "msg-after-open",
      sender: "Carol",
      text: "hello post-open",
    });
    await flushMicrotasks();
    expect(events.length).toBe(1);
    const ev = events[0] as Extract<
      ExtensionToBotMessage,
      { type: "chat.inbound" }
    >;
    expect(ev.fromName).toBe("Carol");
  });

  test("does not click the panel toggle when the panel is already open", () => {
    reader = startChatReader({
      meetingId: "m1",
      selfName: "Bot",
      onEvent: () => {},
    });
    expect(installed!.panelToggleClicks()).toBe(0);
  });

  test("stamps meetingId on every event", async () => {
    const events: ExtensionToBotMessage[] = [];
    reader = startChatReader({
      meetingId: "custom-meeting-xyz",
      selfName: "Bot",
      onEvent: (ev) => events.push(ev),
    });

    installed!.appendMessage({
      id: "msg-99",
      sender: "Dave",
      text: "yo",
    });
    await flushMicrotasks();

    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const e of events) {
      expect(
        (e as Extract<ExtensionToBotMessage, { type: "chat.inbound" }>)
          .meetingId,
      ).toBe("custom-meeting-xyz");
    }
  });

  test("stop() is idempotent", async () => {
    const events: ExtensionToBotMessage[] = [];
    reader = startChatReader({
      meetingId: "m1",
      selfName: "Bot",
      onEvent: (ev) => events.push(ev),
    });

    reader.stop();
    reader.stop(); // second call must not throw

    installed!.appendMessage({
      id: "msg-after-stop",
      sender: "Frank",
      text: "post-stop",
    });
    await flushMicrotasks();
    expect(
      events.map(
        (e) =>
          (e as Extract<ExtensionToBotMessage, { type: "chat.inbound" }>)
            .fromName,
      ),
    ).not.toContain("Frank");

    // Null out so afterEach doesn't call stop again.
    reader = null;
  });
});

describe("sendChat", () => {
  let installed: InstalledDom | null = null;

  beforeEach(() => {
    installed = installChatDom();
  });

  afterEach(() => {
    if (installed) {
      (installed.dom as unknown as { __restore: () => void }).__restore();
      installed = null;
    }
  });

  test("populates the textarea and clicks the send button", async () => {
    const doc = installed!.dom.window.document;
    const input = doc.querySelector<HTMLTextAreaElement>(chatSelectors.INPUT);
    const sendButton = doc.querySelector<HTMLButtonElement>(
      chatSelectors.SEND_BUTTON,
    );
    expect(input).not.toBeNull();
    expect(sendButton).not.toBeNull();

    let sendClicks = 0;
    sendButton!.addEventListener("click", () => {
      sendClicks += 1;
    });

    let inputEvents = 0;
    input!.addEventListener("input", () => {
      inputEvents += 1;
    });

    await sendChat("hello world");

    expect(input!.value).toBe("hello world");
    // The input event must fire so React's controlled-input handler sees
    // the new value.
    expect(inputEvents).toBeGreaterThanOrEqual(1);
    expect(sendClicks).toBe(1);
  });

  test("emits exactly one trusted_type event between the input event and send click when onEvent is provided", async () => {
    const doc = installed!.dom.window.document;
    const input = doc.querySelector<HTMLTextAreaElement>(chatSelectors.INPUT);
    const sendButton = doc.querySelector<HTMLButtonElement>(
      chatSelectors.SEND_BUTTON,
    );
    expect(input).not.toBeNull();
    expect(sendButton).not.toBeNull();

    // Record the temporal order of:
    //   1. each onEvent call (trusted_type or trusted_click for the send button)
    //   2. the send-button click.
    //
    // When `onEvent` is wired, `sendChat` deliberately does NOT dispatch
    // the synthetic `input` event on the textarea — it relies on xdotool
    // to land the keystrokes via trusted X-server events. The synthetic
    // path is only taken as a fallback when no `onEvent` sink is
    // provided (see the regression test below for that path).
    const timeline: Array<
      | { kind: "input"; value: string }
      | { kind: "event"; ev: ExtensionToBotMessage }
      | { kind: "send-click"; inputValue: string }
    > = [];

    input!.addEventListener("input", () => {
      timeline.push({ kind: "input", value: input!.value });
    });
    sendButton!.addEventListener("click", () => {
      timeline.push({ kind: "send-click", inputValue: input!.value });
    });

    const onEvent = (ev: ExtensionToBotMessage): void => {
      timeline.push({ kind: "event", ev });
    };

    await sendChat("hello", {
      onEvent,
      window: {
        screenX: 0,
        screenY: 0,
        outerHeight: 820,
        innerHeight: 720,
      },
    });

    // Exactly one trusted_type event with the literal payload.
    const trustedTypes = timeline.filter(
      (entry): entry is { kind: "event"; ev: ExtensionToBotMessage } =>
        entry.kind === "event" && entry.ev.type === "trusted_type",
    );
    expect(trustedTypes.length).toBe(1);
    const trustedType = trustedTypes[0]!.ev;
    if (trustedType.type === "trusted_type") {
      expect(trustedType.text).toBe("hello");
    }

    // With `onEvent` wired, no synthetic `input` event is dispatched —
    // xdotool is the sole text-entry path. Ordering: trusted_type first,
    // then any send-button trusted_click, then the JS click.
    const inputIdx = timeline.findIndex((e) => e.kind === "input");
    const trustedTypeIdx = timeline.findIndex(
      (e) => e.kind === "event" && e.ev.type === "trusted_type",
    );
    const sendClickIdx = timeline.findIndex((e) => e.kind === "send-click");
    expect(inputIdx).toBe(-1);
    expect(trustedTypeIdx).toBeGreaterThanOrEqual(0);
    expect(sendClickIdx).toBeGreaterThan(trustedTypeIdx);
  });

  test("writes the textarea via the prototype value setter (React controlled-input bypass)", async () => {
    // Meet's composer is a React-controlled textarea: React 16+ wraps the
    // element's `.value` setter with an instance-level interceptor so
    // direct assignment (`input.value = "x"`) updates React's tracker in
    // lockstep with the DOM, and the subsequent synthetic `input` event
    // sees "no change" and skips onChange. `sendChat` must therefore go
    // through `HTMLTextAreaElement.prototype`'s native setter (the
    // prototype descriptor, which the React shim shadows at the instance
    // level) to drive a real value change. This regression test installs
    // an instance-level setter that records whether it was hit — if the
    // old `input.value = text` code path regresses, the instance setter
    // fires and the assertion flips.
    const doc = installed!.dom.window.document;
    const input = doc.querySelector<HTMLTextAreaElement>(chatSelectors.INPUT)!;

    let instanceSetterHits = 0;
    let lastProtoWrite = "";
    // Shadow the prototype `value` setter at the instance level the same
    // way React's `inputValueTracking` does. The native prototype setter
    // (which `sendChat` must call) bypasses this shim entirely, while the
    // old `.value = text` assignment goes through it.
    const protoDesc = Object.getOwnPropertyDescriptor(
      installed!.dom.window.HTMLTextAreaElement.prototype,
      "value",
    );
    if (!protoDesc || !protoDesc.set || !protoDesc.get) {
      throw new Error("jsdom HTMLTextAreaElement.prototype has no value descriptor");
    }
    const protoSetter = protoDesc.set;
    const protoGetter = protoDesc.get;
    Object.defineProperty(input, "value", {
      configurable: true,
      get() {
        return protoGetter.call(input);
      },
      set(v: string) {
        instanceSetterHits += 1;
        // Forward to the prototype so the textarea still receives the
        // value — we only care about counting instance-level hits.
        protoSetter.call(input, v);
      },
    });

    // Record every input event's captured value so we can cross-check
    // that the native-setter write landed before the synthetic event.
    input.addEventListener("input", () => {
      lastProtoWrite = protoGetter.call(input);
    });

    await sendChat("react-controlled");

    expect(instanceSetterHits).toBe(0);
    expect(lastProtoWrite).toBe("react-controlled");
    expect(protoGetter.call(input)).toBe("react-controlled");
  });

  test("accepts exactly 2000 characters", async () => {
    const doc = installed!.dom.window.document;
    const sendButton = doc.querySelector<HTMLButtonElement>(
      chatSelectors.SEND_BUTTON,
    );
    let sendClicks = 0;
    sendButton!.addEventListener("click", () => {
      sendClicks += 1;
    });

    const text = "a".repeat(MEET_CHAT_MAX_LENGTH);
    await sendChat(text);
    expect(sendClicks).toBe(1);
  });

  test("throws when text exceeds the 2000-character cap", async () => {
    const text = "b".repeat(MEET_CHAT_MAX_LENGTH + 1);
    await expect(sendChat(text)).rejects.toThrow(/2000/);
  });

  test("throws when the chat input is missing", async () => {
    const doc = installed!.dom.window.document;
    const input = doc.querySelector<HTMLTextAreaElement>(chatSelectors.INPUT);
    input?.remove();

    await expect(sendChat("hi")).rejects.toThrow(/chat input not found/);
  });

  test("throws when the send button is missing", async () => {
    const doc = installed!.dom.window.document;
    const button = doc.querySelector<HTMLButtonElement>(
      chatSelectors.SEND_BUTTON,
    );
    button?.remove();

    await expect(sendChat("hi")).rejects.toThrow(/send button not found/);
  });

  test("emits a trusted_click with computed screen coords for the send button", async () => {
    // Stub both INPUT and SEND_BUTTON geometry so the coordinate math is
    // deterministic — jsdom returns a zero rect by default. We only care
    // about the send button's coords (the input doesn't emit), but stubbing
    // both keeps the fixture setup explicit. Math mirrors the admission-button
    // and panel-toggle blocks: x = screenX + rect.left + width/2,
    // y = screenY + (outerHeight - innerHeight) + rect.top + height/2.
    const doc = installed!.dom.window.document;
    const input = doc.querySelector<HTMLTextAreaElement>(chatSelectors.INPUT)!;
    input.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        right: 0,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON() {
          return {};
        },
      }) as DOMRect;
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

    let inputEvents = 0;
    input.addEventListener("input", () => {
      inputEvents += 1;
    });
    let sendClicks = 0;
    // Record when `.click()` fires relative to the trusted_click emit so the
    // ordering assertion below has something to compare against.
    const callOrder: string[] = [];
    sendButton.addEventListener("click", () => {
      sendClicks += 1;
      callOrder.push("js-click");
    });

    const events: ExtensionToBotMessage[] = [];
    await sendChat("hello", {
      onEvent: (ev) => {
        events.push(ev);
        if (ev.type === "trusted_click") callOrder.push("trusted-click");
      },
      // chrome = outerHeight - innerHeight = 100; screen origin = (0, 0).
      // Expected send button: x = 1300 + 30 = 1330, y = 100 + 700 + 20 = 820.
      window: {
        screenX: 0,
        screenY: 0,
        outerHeight: 820,
        innerHeight: 720,
      },
    });

    const trustedClicks = events.filter(
      (e) => e.type === "trusted_click",
    ) as Array<Extract<ExtensionToBotMessage, { type: "trusted_click" }>>;
    expect(trustedClicks.length).toBe(1);
    expect(trustedClicks[0]!.x).toBe(1330);
    expect(trustedClicks[0]!.y).toBe(820);

    // With `onEvent` wired, sendChat relies on xdotool for text entry and
    // skips the synthetic `.value = text` + `input` event dispatch — the
    // composer is populated by the bot's xdotool-driven keystrokes, not
    // by the extension. So the textarea stays empty in-test, and no
    // synthetic `input` event fires.
    expect(input.value).toBe("");
    expect(inputEvents).toBe(0);

    // JS click fallback still fires AFTER the trusted_click — the bot will
    // already have dispatched the real xdotool click by the time the JS
    // `.click()` runs, so ordering matters for any isTrusted-relaxed build.
    expect(sendClicks).toBe(1);
    expect(callOrder).toEqual(["trusted-click", "js-click"]);
  });
});

describe("postConsentMessage", () => {
  let installed: InstalledDom | null = null;

  beforeEach(() => {
    installed = installChatDom();
  });

  afterEach(() => {
    if (installed) {
      (installed.dom as unknown as { __restore: () => void }).__restore();
      installed = null;
    }
  });

  test("opens the panel (if closed) and sends the message", async () => {
    installed!.closePanel();
    expect(installed!.panelToggleClicks()).toBe(0);

    const doc = installed!.dom.window.document;
    let sendClicks = 0;
    // The send button doesn't exist until the toggle-click handler
    // remounts the chat surface, so attach the listener inside the
    // post-mount hook.
    installed!.onPanelOpen(() => {
      doc
        .querySelector<HTMLButtonElement>(chatSelectors.SEND_BUTTON)!
        .addEventListener("click", () => {
          sendClicks += 1;
        });
    });

    await postConsentMessage("consent please");

    expect(installed!.panelToggleClicks()).toBe(1);
    expect(sendClicks).toBe(1);
    // No `onEvent` wired → sendChat takes the synthetic-setter fallback,
    // which still populates the composer in the jsdom harness.
    const input = doc.querySelector<HTMLTextAreaElement>(chatSelectors.INPUT);
    expect(input!.value).toBe("consent please");
  });

  test("does not click the panel toggle when already open", async () => {
    expect(installed!.panelToggleClicks()).toBe(0);
    await postConsentMessage("already open");
    expect(installed!.panelToggleClicks()).toBe(0);
  });

  test("emits two trusted_clicks with computed screen coords when the panel is closed (toggle + send)", async () => {
    installed!.closePanel();

    // Stub both the toggle's and send button's geometry so the coordinate
    // math is deterministic — jsdom returns a zero rect by default. Math
    // mirrors the admission-button block in `features/join.ts`:
    //   x = screenX + rect.left + width/2,
    //   y = screenY + (outerHeight - innerHeight) + rect.top + height/2.
    const doc = installed!.dom.window.document;
    const toggle = doc.querySelector(chatSelectors.PANEL_BUTTON) as HTMLElement;
    toggle.getBoundingClientRect = () =>
      ({
        left: 1200,
        top: 60,
        width: 40,
        height: 40,
        right: 1240,
        bottom: 100,
        x: 1200,
        y: 60,
        toJSON() {
          return {};
        },
      }) as DOMRect;

    // Stub the send button geometry via the post-mount hook — `closePanel`
    // now tears down the entire chat surface (list + composer + send) to
    // mirror production, so the send button doesn't exist until the
    // toggle-click handler remounts it. Registering the stub here guarantees
    // it runs right after remount and before `sendChat` reads the rect.
    installed!.onPanelOpen(() => {
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
    });

    const events: ExtensionToBotMessage[] = [];
    await postConsentMessage("hi", {
      onEvent: (ev) => events.push(ev),
      // chrome = outerHeight - innerHeight = 100; screen origin = (0, 0).
      // Expected toggle: x = 1200 + 20 = 1220, y = 100 + 60 + 20 = 180.
      // Expected send:   x = 1300 + 30 = 1330, y = 100 + 700 + 20 = 820.
      window: {
        screenX: 0,
        screenY: 0,
        outerHeight: 820,
        innerHeight: 720,
      },
    });

    const trustedClicks = events.filter(
      (e) => e.type === "trusted_click",
    ) as Array<Extract<ExtensionToBotMessage, { type: "trusted_click" }>>;
    // TWO trusted_clicks now: toggle (from ensurePanelOpen) then send (from
    // sendChat). Asserting the order catches any regression where sendChat
    // stops receiving `opts` or the order inverts.
    expect(trustedClicks.length).toBe(2);
    expect(trustedClicks[0]!.x).toBe(1220);
    expect(trustedClicks[0]!.y).toBe(180);
    expect(trustedClicks[1]!.x).toBe(1330);
    expect(trustedClicks[1]!.y).toBe(820);

    // JS click fallback still fired for the toggle (opens the panel in the
    // jsdom harness).
    expect(installed!.panelToggleClicks()).toBe(1);
  });

  test("emits only the send trusted_click when the panel is already open", async () => {
    // Panel already open (MESSAGE_LIST mounted) — ensurePanelOpen must
    // short-circuit before the toggle-lookup + emit path, but sendChat still
    // emits its own trusted_click for the send button.
    const doc = installed!.dom.window.document;
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

    const events: ExtensionToBotMessage[] = [];
    await postConsentMessage("hi", {
      onEvent: (ev) => events.push(ev),
      window: {
        screenX: 0,
        screenY: 0,
        outerHeight: 820,
        innerHeight: 720,
      },
    });

    const trustedClicks = events.filter(
      (e) => e.type === "trusted_click",
    ) as Array<Extract<ExtensionToBotMessage, { type: "trusted_click" }>>;
    expect(trustedClicks.length).toBe(1);
    expect(trustedClicks[0]!.x).toBe(1330);
    expect(trustedClicks[0]!.y).toBe(820);
    // Toggle was never clicked because the panel was already open.
    expect(installed!.panelToggleClicks()).toBe(0);
  });

  test("awaits the panel to mount before querying the chat input (xdotool race)", async () => {
    // Regression: in production, Meet's isTrusted gate rejects the JS
    // `.click()` fallback on the panel toggle, so the MESSAGE_LIST only
    // mounts after the bot's xdotool-driven X-server click lands (tens of
    // ms later). Before this fix, `postConsentMessage` called the sync
    // version of `ensurePanelOpen` and then IMMEDIATELY queried
    // `chatSelectors.INPUT` inside `sendChat` — which threw
    // `"chat input not found"` because the composer hadn't mounted yet.
    //
    // We simulate that race by:
    //   1. Replacing the default toggle (whose jsdom handler synchronously
    //      mounts the MESSAGE_LIST on click) with a fresh toggle whose
    //      click handler is a no-op — i.e. the isTrusted gate rejects the
    //      click, matching production behavior.
    //   2. Closing the panel (removing MESSAGE_LIST + composer) so
    //      `ensurePanelOpen` takes the click path.
    //   3. Scheduling an async mount of MESSAGE_LIST + composer + send
    //      button at +50ms, mimicking xdotool's end-to-end latency.
    //
    // The test asserts that `postConsentMessage` does NOT throw and that
    // the composer is populated — which is only possible if
    // `ensurePanelOpen` awaits the mount before handing control to
    // `sendChat`.
    const doc = installed!.dom.window.document;

    // Remove everything the chat fixture provides so the composer genuinely
    // has to be mounted asynchronously — including the existing send button
    // and composer textarea.
    doc.querySelector(chatSelectors.MESSAGE_LIST)?.remove();
    doc.querySelector(chatSelectors.INPUT)?.remove();
    doc.querySelector(chatSelectors.SEND_BUTTON)?.remove();

    // Replace the toggle with a fresh button that does nothing on click —
    // simulating Meet's isTrusted gate rejecting the JS click. The
    // original toggle (which synchronously re-mounts the list) is removed.
    doc.querySelector(chatSelectors.PANEL_BUTTON)?.remove();
    const toggle = doc.createElement("button");
    toggle.setAttribute("type", "button");
    toggle.setAttribute("aria-label", "Chat with everyone");
    toggle.textContent = "Chat";
    doc.body.appendChild(toggle);
    let toggleClickCount = 0;
    toggle.addEventListener("click", () => {
      toggleClickCount += 1;
      // Intentionally NO re-mount here — simulating Meet's isTrusted gate.
    });

    // Schedule the async mount to land after a short delay, mimicking the
    // xdotool-driven X-server click arriving at Chromium and React
    // re-rendering the panel. 50ms is well under the
    // ENSURE_PANEL_OPEN_TIMEOUT_MS (2000ms) deadline, so the poll must
    // resolve before the timeout fires.
    setTimeout(() => {
      const list = doc.createElement("div");
      list.setAttribute("role", "list");
      list.setAttribute("aria-label", "Chat messages");
      doc.body.appendChild(list);

      const input = doc.createElement("textarea");
      input.setAttribute("aria-label", "Send a message");
      doc.body.appendChild(input);

      const sendButton = doc.createElement("button");
      sendButton.setAttribute("type", "button");
      sendButton.setAttribute("aria-label", "Send a message");
      sendButton.textContent = "Send";
      doc.body.appendChild(sendButton);
    }, 50);

    // Record when `sendChat` queries the INPUT vs. when the mount happens,
    // so a regression (sync path) would throw and fail the await below
    // instead of flakily passing.
    await postConsentMessage("hi there");

    // The toggle was clicked exactly once (via the JS `.click()` fallback).
    expect(toggleClickCount).toBe(1);

    // The composer now carries the message — only possible if
    // `ensurePanelOpen` awaited the mount.
    const input = doc.querySelector<HTMLTextAreaElement>(chatSelectors.INPUT);
    expect(input).not.toBeNull();
    expect(input!.value).toBe("hi there");

    // And the list is mounted now, proving the async mount fired before
    // the chat post completed.
    expect(doc.querySelector(chatSelectors.MESSAGE_LIST)).not.toBeNull();
  });

  test("opens the panel when MESSAGE_LIST aria-label has drifted off the known value", async () => {
    // Regression: Meet's "Continuous chat is turned off" mode renders the
    // chat panel header as "In-call messages" and may rename the
    // underlying list's aria-label off "Chat messages" — the selector
    // `[role="list"][aria-label="Chat messages"]` then misses even though
    // the composer is present and usable. Before the composer-anchored
    // short-circuit, ensurePanelOpen would click the toggle (closing the
    // panel!) and the subsequent sendChat query would race the panel
    // remount and throw "chat input not found".
    //
    // We simulate that state by removing MESSAGE_LIST and mounting a
    // drifted-aria-label list alongside a working composer + send
    // button. `ensurePanelOpen` must see the composer, short-circuit,
    // and leave the toggle alone.
    const doc = installed!.dom.window.document;
    doc.querySelector(chatSelectors.MESSAGE_LIST)?.remove();
    const driftedList = doc.createElement("div");
    driftedList.setAttribute("role", "list");
    driftedList.setAttribute("aria-label", "In-call messages");
    doc.body.appendChild(driftedList);
    // Composer + send button are already in the fixture — leave them.

    expect(installed!.panelToggleClicks()).toBe(0);
    await postConsentMessage("hi");
    // No toggle click: the composer was already visible, so the panel
    // was deemed open without re-toggling. A regression would click
    // once (or more, driving the panel closed) here.
    expect(installed!.panelToggleClicks()).toBe(0);
    const input = doc.querySelector<HTMLTextAreaElement>(chatSelectors.INPUT);
    expect(input!.value).toBe("hi");
  });
});
