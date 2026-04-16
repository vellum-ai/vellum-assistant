/**
 * In-meeting chat reader.
 *
 * `startChatReader(page, onMessage, opts)` wires up a streaming observer over
 * Meet's chat panel so every new inbound message is surfaced as an
 * `InboundChatEvent` on the assistant side. Downstream consumers (PR 17's
 * conversation bridge, PR 22's consent monitor) rely on these events to
 * reflect chat traffic back into the assistant conversation.
 *
 * ## Flow
 *
 * 1. Ensure the chat panel is open — Meet hides the message list and composer
 *    behind a toolbar toggle (`INGAME_CHAT_PANEL_BUTTON`). We detect the
 *    current state by querying for the message-list selector; if it's absent,
 *    we click the panel button once. This avoids toggling a panel that is
 *    already open (which would close it and break the observer).
 * 2. Install a `MutationObserver` inside the page via `page.evaluate`. The
 *    observer watches the message container for added nodes and forwards
 *    each new `INGAME_CHAT_MESSAGE_NODE` out through a bridge function we
 *    exposed via `page.exposeFunction`. This keeps the bot-side event path
 *    push-driven (no polling, minimal latency).
 * 3. **Fallback**: if any step of the mutation-observer path fails (e.g. the
 *    page has no `document` yet, or `exposeFunction` rejects because the
 *    binding already exists after a navigation), we fall back to polling the
 *    message list every 500ms and diffing against a seen-set.
 *
 * ## Dedupe
 *
 * Two layers:
 *   - In-page: the observer tracks message DOM IDs it has already forwarded,
 *     so re-renders of the same message don't fire twice.
 *   - Bot-side: we key on `sender + text + floor(timestampMs / 1000)` so even
 *     if a message resurfaces across a panel-close/reopen (clearing the
 *     in-page seen set), we don't double-emit within a 1-second bucket.
 *
 * ## Self-filter
 *
 * Meet renders the bot's own outbound messages back into the chat list. We
 * drop anything whose rendered sender name matches `opts.selfName`. When the
 * DOM exposes a more specific `data-is-self="true"` attribute (some Meet
 * variants do) we treat that as authoritative.
 */

import type { Page } from "playwright";

import type { InboundChatEvent } from "../../../contracts/index.js";

import { chatSelectors } from "./dom-selectors.js";

/** Options passed to `startChatReader`. */
export interface ChatReaderOptions {
  /** Meeting ID stamped on every emitted event. */
  meetingId: string;
  /** The bot's display name — used to drop the bot's own messages. */
  selfName: string;
}

/** Handle returned by `startChatReader`. */
export interface ChatReader {
  /**
   * Tear down the in-page observer (or polling loop) and unsubscribe the
   * bot-side callback. Safe to call multiple times — subsequent calls are
   * no-ops.
   */
  stop: () => Promise<void>;
}

/**
 * Raw message payload extracted from the DOM before bot-side filtering.
 *
 * `timestampMs` is the sender-side timestamp parsed from the
 * `<time datetime>` attribute when available, or `Date.now()` as a fallback.
 * `isSelf` is a hint pulled from `data-is-self` when the DOM provides it.
 */
interface RawChatMessage {
  domId: string;
  fromName: string;
  fromId: string;
  text: string;
  timestampMs: number;
  isSelf: boolean;
}

/** Unique binding name for the `exposeFunction` bridge, per-reader. */
let bindingCounter = 0;

/**
 * Launch a chat reader against `page`, emitting `InboundChatEvent` to
 * `onMessage` for every new inbound chat message.
 */
export async function startChatReader(
  page: Page,
  onMessage: (event: InboundChatEvent) => void,
  opts: ChatReaderOptions,
): Promise<ChatReader> {
  const bindingName = `__meetBotChatBridge_${++bindingCounter}`;

  // Bot-side dedupe: `sender|text|timestampBucketSeconds`. A 1-second bucket
  // tolerates clock-skew and millisecond jitter between the rendered
  // timestamp and our DOM read, while still catching identical rapid-fire
  // re-posts (which would be unusual in practice).
  const seenKeys = new Set<string>();
  const dedupeKey = (sender: string, text: string, tsMs: number): string =>
    `${sender}|${text}|${Math.floor(tsMs / 1000)}`;

  const handleRaw = (raw: RawChatMessage): void => {
    // Authoritative self-flag wins; otherwise match by display name.
    const isSelf = raw.isSelf || raw.fromName === opts.selfName;
    if (isSelf) return;

    const key = dedupeKey(raw.fromName, raw.text, raw.timestampMs);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    const event: InboundChatEvent = {
      type: "chat.inbound",
      meetingId: opts.meetingId,
      // Emit when the bot observed the message, not when Meet rendered the
      // sender-side timestamp. Keeps event ordering consistent with the rest
      // of the pipeline (which uses bot-observation time).
      timestamp: new Date().toISOString(),
      fromId: raw.fromId,
      fromName: raw.fromName,
      text: raw.text,
    };
    try {
      onMessage(event);
    } catch {
      // Don't let a subscriber throw kill the observer loop.
    }
  };

  // Ensure the chat panel is open. We treat the existence of a message-node
  // *selector match* (even an empty list) as a signal that the panel is
  // mounted. If the selector returns nothing, we click the toolbar toggle.
  await ensurePanelOpen(page);

  // Prefer the MutationObserver path; on any failure, fall back to polling.
  let stopFn: () => Promise<void>;
  try {
    stopFn = await installMutationObserver(page, bindingName, handleRaw);
  } catch {
    stopFn = installPollingLoop(page, handleRaw);
  }

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await stopFn();
    },
  };
}

/**
 * Click the chat toggle once if the panel isn't already open. Idempotent —
 * if Meet renders the message-list regardless of panel visibility, the
 * query-selector check short-circuits and we never click.
 */
async function ensurePanelOpen(page: Page): Promise<void> {
  try {
    const alreadyOpen = await page.evaluate((sel) => {
      return document.querySelector(sel) !== null;
    }, chatSelectors.MESSAGE_NODE);
    if (alreadyOpen) return;

    const toggle = await page.$(chatSelectors.PANEL_BUTTON);
    if (toggle) {
      await toggle.click().catch(() => {
        // Click can fail if the button is detached mid-flight; that's fine —
        // the fallback polling loop will still find messages if/when they
        // render.
      });
    }
  } catch {
    // If the page is already closed or we can't reach the DOM, leave it to
    // the observer/polling path to surface errors naturally.
  }
}

/**
 * Install an in-page `MutationObserver` over the chat message container and
 * bridge each new message out via `page.exposeFunction`.
 *
 * Returns a teardown function that disconnects the observer and clears the
 * window-level bridge reference. The `exposeFunction` binding itself cannot
 * be removed once registered, but nulling out the window-level observer
 * handle is enough to stop further callbacks.
 */
async function installMutationObserver(
  page: Page,
  bindingName: string,
  onRaw: (raw: RawChatMessage) => void,
): Promise<() => Promise<void>> {
  await page.exposeFunction(bindingName, (raw: RawChatMessage) => {
    onRaw(raw);
  });

  await page.evaluate(
    (args: {
      bindingName: string;
      messageNodeSelector: string;
      senderSelector: string;
      textSelector: string;
      timestampSelector: string;
    }) => {
      // Guard against re-entry: if a previous reader already installed an
      // observer on this page (unusual, but possible after a reconnect), we
      // replace it with ours. The caller controls teardown via the handle
      // returned from this function.
      const w = window as unknown as Record<string, unknown>;
      const prior = w.__meetBotChatObserver as MutationObserver | undefined;
      if (prior && typeof prior.disconnect === "function") {
        prior.disconnect();
      }

      const seenDomIds = new Set<string>();
      const extract = (node: Element): void => {
        // Scope to the rendered message nodes — ignore wrappers that don't
        // match the selector so we don't misread unrelated DOM churn as
        // chat traffic.
        const messages = node.matches(args.messageNodeSelector)
          ? [node]
          : Array.from(node.querySelectorAll(args.messageNodeSelector));
        for (const msg of messages) {
          const domId =
            msg.getAttribute("data-message-id") ??
            msg.getAttribute("id") ??
            "";
          if (!domId) continue;
          if (seenDomIds.has(domId)) continue;
          seenDomIds.add(domId);

          const senderEl = msg.querySelector(args.senderSelector);
          const textEl = msg.querySelector(args.textSelector);
          const timeEl = msg.querySelector(args.timestampSelector);

          const fromName = (senderEl?.textContent ?? "").trim();
          const text = (textEl?.textContent ?? "").trim();
          if (!fromName || !text) continue;

          // Sender-side id if Meet exposes one; otherwise fall back to the
          // display name (stable enough for dedupe within a meeting).
          const fromId =
            senderEl?.getAttribute("data-sender-id") ?? fromName;

          let timestampMs = Date.now();
          const iso = timeEl?.getAttribute("datetime");
          if (iso) {
            const parsed = Date.parse(iso);
            if (!Number.isNaN(parsed)) timestampMs = parsed;
          }

          const isSelf =
            msg.getAttribute("data-is-self") === "true" ||
            senderEl?.getAttribute("data-is-self") === "true";

          const bridge = w[args.bindingName] as
            | ((raw: unknown) => void)
            | undefined;
          if (typeof bridge === "function") {
            bridge({
              domId,
              fromName,
              fromId,
              text,
              timestampMs,
              isSelf,
            });
          }
        }
      };

      // Backfill any messages already in the DOM when the reader attaches —
      // otherwise we'd miss the pre-join history.
      for (const existing of document.querySelectorAll(
        args.messageNodeSelector,
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
      w.__meetBotChatObserver = observer;
    },
    {
      bindingName,
      messageNodeSelector: chatSelectors.MESSAGE_NODE,
      senderSelector: chatSelectors.MESSAGE_SENDER,
      textSelector: chatSelectors.MESSAGE_TEXT,
      timestampSelector: chatSelectors.MESSAGE_TIMESTAMP,
    },
  );

  return async () => {
    try {
      await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const observer = w.__meetBotChatObserver as
          | MutationObserver
          | undefined;
        if (observer && typeof observer.disconnect === "function") {
          observer.disconnect();
        }
        delete w.__meetBotChatObserver;
      });
    } catch {
      // Page may already be closed.
    }
  };
}

/**
 * Fallback path: poll the message container every 500ms and emit any
 * message DOM IDs we haven't seen before. Used when the MutationObserver
 * path fails (e.g. in test environments where `exposeFunction` isn't
 * available).
 */
function installPollingLoop(
  page: Page,
  onRaw: (raw: RawChatMessage) => void,
): () => Promise<void> {
  const seenDomIds = new Set<string>();
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const batch = await page.evaluate(
        (args: {
          messageNodeSelector: string;
          senderSelector: string;
          textSelector: string;
          timestampSelector: string;
        }): RawChatMessage[] => {
          const out: RawChatMessage[] = [];
          for (const msg of document.querySelectorAll(
            args.messageNodeSelector,
          )) {
            const domId =
              msg.getAttribute("data-message-id") ??
              msg.getAttribute("id") ??
              "";
            if (!domId) continue;

            const senderEl = msg.querySelector(args.senderSelector);
            const textEl = msg.querySelector(args.textSelector);
            const timeEl = msg.querySelector(args.timestampSelector);

            const fromName = (senderEl?.textContent ?? "").trim();
            const text = (textEl?.textContent ?? "").trim();
            if (!fromName || !text) continue;

            const fromId =
              senderEl?.getAttribute("data-sender-id") ?? fromName;

            let timestampMs = Date.now();
            const iso = timeEl?.getAttribute("datetime");
            if (iso) {
              const parsed = Date.parse(iso);
              if (!Number.isNaN(parsed)) timestampMs = parsed;
            }

            const isSelf =
              msg.getAttribute("data-is-self") === "true" ||
              senderEl?.getAttribute("data-is-self") === "true";

            out.push({
              domId,
              fromName,
              fromId,
              text,
              timestampMs,
              isSelf,
            });
          }
          return out;
        },
        {
          messageNodeSelector: chatSelectors.MESSAGE_NODE,
          senderSelector: chatSelectors.MESSAGE_SENDER,
          textSelector: chatSelectors.MESSAGE_TEXT,
          timestampSelector: chatSelectors.MESSAGE_TIMESTAMP,
        },
      );

      for (const raw of batch) {
        if (seenDomIds.has(raw.domId)) continue;
        seenDomIds.add(raw.domId);
        onRaw(raw);
      }
    } catch {
      // Page may have closed; the stop() caller will clean up the timer.
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, 500);
  // Fire an immediate tick so pre-existing messages surface without waiting
  // a full interval.
  void tick();

  return async () => {
    stopped = true;
    clearInterval(interval);
  };
}
