/**
 * In-meeting chat reader + sender for the content script.
 *
 * Ports `skills/meet-join/bot/src/browser/chat-reader.ts` and
 * `chat-bridge.ts` from the Playwright-driven bot into the extension. The
 * content script runs inside Meet's page world, so we operate on `document`
 * directly instead of going through Playwright's `page.evaluate` /
 * `exposeFunction` bridge. That simplifies the reader (we keep a single
 * in-process observer — no polling fallback needed) and the sender (we drive
 * the textarea via `value` + synthetic `input` event instead of Playwright's
 * `fill`).
 *
 * The exported surface matches what the rest of the extension (content.ts)
 * and the join flow (PR 9) expect:
 *
 * - {@link startChatReader} — installs a `MutationObserver` on the chat
 *   message list and emits `chat.inbound` events for every inbound message.
 * - {@link sendChat} — types `text` into the composer and clicks send.
 *   Enforces Meet's 2000-character limit.
 * - {@link postConsentMessage} — thin wrapper over `sendChat` that ensures
 *   the chat panel is open first. Invoked by the join flow once the bot
 *   lands in the meeting room.
 *
 * ## Self-filter
 *
 * Meet renders the bot's own outbound messages back into the chat list. We
 * drop anything whose rendered sender name matches `opts.selfName`, and we
 * treat an authoritative `data-is-self="true"` attribute as a stronger
 * signal when Meet exposes it.
 *
 * ## Dedupe
 *
 * The in-page observer tracks seen message DOM IDs, and we layer a second
 * seen-set on top of the bot-side callback so panel close/reopen cycles
 * (which reset the in-page set when the observer is reinstalled) don't
 * double-emit the same message.
 */

import type {
  ExtensionInboundChatMessage,
  ExtensionToBotMessage,
} from "../../../contracts/native-messaging.js";
import { chatSelectors } from "../dom/selectors.js";

/**
 * Meet's chat composer enforces a 2000-character cap server-side. We mirror
 * that cap here so callers get a fast, local error instead of a silent drop
 * or a panel toast. Must stay in sync with `MEET_CHAT_MAX_LENGTH` in
 * `skills/meet-join/bot/src/control/http-server.ts`.
 */
export const MEET_CHAT_MAX_LENGTH = 2000;

/** Options passed to {@link startChatReader}. */
export interface ChatReaderOptions {
  /** Meeting ID stamped on every emitted event. */
  meetingId: string;
  /** The bot's display name — used to drop the bot's own messages. */
  selfName: string;
  /**
   * Callback invoked for every validated {@link ExtensionToBotMessage}
   * produced by the reader. Currently only `chat.inbound` events flow
   * through here; the event type is widened to {@link ExtensionToBotMessage}
   * so content.ts can forward directly to `chrome.runtime.sendMessage`
   * without re-wrapping.
   */
  onEvent: (ev: ExtensionToBotMessage) => void;
}

/** Handle returned by {@link startChatReader}. */
export interface ChatReader {
  /**
   * Tear down the observer. Safe to call multiple times — subsequent calls
   * are no-ops.
   */
  stop: () => void;
}

/**
 * Install a `MutationObserver` over Meet's chat panel and invoke
 * `opts.onEvent` for every new inbound chat message.
 *
 * Opens the chat panel if it is currently collapsed (otherwise the message
 * list is not mounted and the observer has nothing to watch).
 */
export function startChatReader(opts: ChatReaderOptions): ChatReader {
  ensurePanelOpen();

  // Bot-side dedupe keyed on the rendered `data-message-id`. The in-page
  // seen set is reset every time the panel close/reopens and the observer
  // re-attaches, so we keep our own set to survive those cycles.
  const seenDomIds = new Set<string>();

  const extract = (node: Element): void => {
    const messages = node.matches(chatSelectors.MESSAGE_NODE)
      ? [node]
      : Array.from(node.querySelectorAll(chatSelectors.MESSAGE_NODE));
    for (const msg of messages) {
      const domId =
        msg.getAttribute("data-message-id") ?? msg.getAttribute("id") ?? "";
      if (!domId) continue;
      if (seenDomIds.has(domId)) continue;

      const senderEl = msg.querySelector(chatSelectors.MESSAGE_SENDER);
      const textEl = msg.querySelector(chatSelectors.MESSAGE_TEXT);

      const fromName = (senderEl?.textContent ?? "").trim();
      const text = (textEl?.textContent ?? "").trim();
      if (!fromName || !text) continue;

      // Authoritative self-flag wins; otherwise match by display name.
      const isSelf =
        msg.getAttribute("data-is-self") === "true" ||
        senderEl?.getAttribute("data-is-self") === "true" ||
        fromName === opts.selfName;
      if (isSelf) {
        // Record the DOM id anyway so we don't re-inspect the node on the
        // next mutation.
        seenDomIds.add(domId);
        continue;
      }

      // Sender-side id when Meet exposes one; otherwise fall back to the
      // display name (stable enough within a meeting).
      const fromId = senderEl?.getAttribute("data-sender-id") ?? fromName;

      seenDomIds.add(domId);

      const event: ExtensionInboundChatMessage = {
        type: "chat.inbound",
        meetingId: opts.meetingId,
        // Emit bot-observation time, not Meet's sender-side timestamp. Keeps
        // event ordering consistent with the rest of the pipeline.
        timestamp: new Date().toISOString(),
        fromId,
        fromName,
        text,
      };
      try {
        opts.onEvent(event);
      } catch {
        // Don't let a subscriber throw kill the observer loop.
      }
    }
  };

  // Backfill any messages already in the DOM when the reader attaches —
  // otherwise we'd miss the pre-existing chat history.
  for (const existing of document.querySelectorAll(
    chatSelectors.MESSAGE_NODE,
  )) {
    extract(existing);
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) extract(node as Element);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
    },
  };
}

/**
 * Type `text` into Meet's chat composer and submit it.
 *
 * Throws synchronously if `text` exceeds {@link MEET_CHAT_MAX_LENGTH}. If
 * the composer input or send button is missing, throws a descriptive error.
 * Assumes the chat panel is open — callers that need to lazily open it
 * should use {@link postConsentMessage}.
 */
export async function sendChat(text: string): Promise<void> {
  if (text.length > MEET_CHAT_MAX_LENGTH) {
    throw new Error(
      `text exceeds Meet chat limit of ${MEET_CHAT_MAX_LENGTH} characters (got ${text.length})`,
    );
  }

  const input = document.querySelector<HTMLTextAreaElement>(chatSelectors.INPUT);
  if (!input) {
    throw new Error(
      `sendChat: chat input not found (selector: ${chatSelectors.INPUT})`,
    );
  }

  // Meet's composer is a React-controlled textarea. Simply setting `.value`
  // doesn't update React's internal state — we have to dispatch a synthetic
  // `input` event so React's onChange handler picks up the new value. This
  // mirrors the technique the bot-side `page.fill` ultimately uses under the
  // hood through Playwright's element-handle bindings.
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));

  const sendButton = document.querySelector<HTMLButtonElement>(
    chatSelectors.SEND_BUTTON,
  );
  if (!sendButton) {
    throw new Error(
      `sendChat: send button not found (selector: ${chatSelectors.SEND_BUTTON})`,
    );
  }
  sendButton.click();
}

/**
 * Ensure the chat panel is open and then call {@link sendChat}.
 *
 * Invoked by the join flow to drop the consent notice once the bot is in
 * the meeting. Safe to call exactly once per session — if the composer is
 * already visible, we skip the panel-toggle click (clicking again would
 * close the panel).
 */
export async function postConsentMessage(text: string): Promise<void> {
  ensurePanelOpen();
  await sendChat(text);
}

/**
 * Click the chat toggle once if the panel isn't already open. Detects open
 * state via the message-list container (mounted even when empty), not
 * individual message nodes which require at least one message to exist.
 */
function ensurePanelOpen(): void {
  if (document.querySelector(chatSelectors.MESSAGE_LIST)) return;
  const toggle = document.querySelector<HTMLButtonElement>(
    chatSelectors.PANEL_BUTTON,
  );
  if (toggle) {
    try {
      toggle.click();
    } catch {
      // Click can fail if the button is detached mid-flight; let the caller
      // surface the downstream selector error when the composer isn't
      // findable.
    }
  }
}
