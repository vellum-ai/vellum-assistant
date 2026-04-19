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
  const attachToggleHandler = (): void => {
    const toggle = document.querySelector(chatSelectors.PANEL_BUTTON);
    if (!toggle) return;
    toggle.addEventListener("click", () => {
      toggleClicks += 1;
      // If the message list has been removed, recreate it so a subsequent
      // query succeeds.
      if (!document.querySelector(chatSelectors.MESSAGE_LIST)) {
        const aside = document.querySelector("aside");
        const list = document.createElement("div");
        list.setAttribute("role", "list");
        list.setAttribute("aria-label", "Chat messages");
        aside?.insertBefore(list, aside.firstChild);
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
    const list = document.querySelector(chatSelectors.MESSAGE_LIST);
    list?.remove();
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
      (
        installed.dom as unknown as { __restore: () => void }
      ).__restore();
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
      (
        installed.dom as unknown as { __restore: () => void }
      ).__restore();
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
});

describe("postConsentMessage", () => {
  let installed: InstalledDom | null = null;

  beforeEach(() => {
    installed = installChatDom();
  });

  afterEach(() => {
    if (installed) {
      (
        installed.dom as unknown as { __restore: () => void }
      ).__restore();
      installed = null;
    }
  });

  test("opens the panel (if closed) and sends the message", async () => {
    installed!.closePanel();
    expect(installed!.panelToggleClicks()).toBe(0);

    const doc = installed!.dom.window.document;
    let sendClicks = 0;
    doc
      .querySelector<HTMLButtonElement>(chatSelectors.SEND_BUTTON)!
      .addEventListener("click", () => {
        sendClicks += 1;
      });

    await postConsentMessage("consent please");

    expect(installed!.panelToggleClicks()).toBe(1);
    expect(sendClicks).toBe(1);
    const input = doc.querySelector<HTMLTextAreaElement>(chatSelectors.INPUT);
    expect(input!.value).toBe("consent please");
  });

  test("does not click the panel toggle when already open", async () => {
    expect(installed!.panelToggleClicks()).toBe(0);
    await postConsentMessage("already open");
    expect(installed!.panelToggleClicks()).toBe(0);
  });
});
