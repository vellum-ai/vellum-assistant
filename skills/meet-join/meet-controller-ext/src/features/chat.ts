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
import { trustedTypeDurationMs } from "../../../contracts/native-messaging.js";
import { chatSelectors } from "../dom/selectors.js";
import { waitForSelector } from "../dom/wait.js";

/**
 * Build a one-line inventory of the current DOM state that is most useful
 * when the composer query turns up empty. Embeds:
 *
 *   - `chat-panel-button`: whether the toggle exists and its aria-expanded
 *     / aria-pressed state — answers "is the chat panel actually open?".
 *   - `aria-labels`: up to 20 `[aria-label]` elements as `TAG[label]` tuples
 *     so we can spot localization or wording drift ("Send a message" →
 *     something else) at a glance.
 *   - `contenteditables`: count + the closest `[aria-label]` for each,
 *     since the editable target is the thing that needs to be findable.
 *   - `shadow-roots`: count of elements with an attached `shadowRoot` so
 *     a shadow-DOM-encapsulated composer shows up as a non-zero count
 *     here even though `querySelector` returned nothing for it.
 *
 * Kept as a helper so the sender/panel-open paths stay readable and the
 * diagnostic format stays identical across call sites.
 */
function describeComposerSearch(): string {
  const parts: string[] = [];

  const toggle = document.querySelector(chatSelectors.PANEL_BUTTON);
  if (toggle) {
    const expanded = toggle.getAttribute("aria-expanded") ?? "<unset>";
    const pressed = toggle.getAttribute("aria-pressed") ?? "<unset>";
    parts.push(
      `chat-panel-button: found (aria-expanded=${expanded}, aria-pressed=${pressed})`,
    );
  } else {
    parts.push("chat-panel-button: <missing>");
  }

  const ariaLabeled = Array.from(document.querySelectorAll("[aria-label]"));
  const ariaInventory = ariaLabeled
    .slice(0, 20)
    .map((el) => {
      const label = (el.getAttribute("aria-label") ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 60);
      return `${el.tagName}[${label}]`;
    })
    .join(", ");
  parts.push(
    `aria-labels(${ariaLabeled.length}): ${ariaInventory || "<none>"}`,
  );

  const editables = Array.from(document.querySelectorAll("[contenteditable]"));
  const editableInventory = editables
    .slice(0, 6)
    .map((el) => {
      const nearest = el.closest("[aria-label]");
      const label = nearest?.getAttribute("aria-label") ?? "<no-aria-ancestor>";
      return `${el.tagName}<=${label.replace(/\s+/g, " ").slice(0, 40)}`;
    })
    .join(", ");
  parts.push(
    `contenteditables(${editables.length}): ${editableInventory || "<none>"}`,
  );

  // Non-zero here means the composer may be inside an encapsulated subtree
  // that a plain `querySelector` cannot pierce.
  const shadowHosts = Array.from(document.querySelectorAll("*")).filter(
    (el) => (el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot,
  );
  parts.push(`shadow-roots: ${shadowHosts.length}`);

  return parts.join("; ");
}

/**
 * How long {@link ensurePanelOpen} waits for the chat message list to mount
 * after clicking the toggle before giving up.
 *
 * Sized for Meet's production latency: the xdotool `trusted_click` is a
 * fire-and-forget native-messaging emit to the bot, which then drives an
 * X-server click via xdotool against the Xvfb display. Measured end-to-end
 * latency (emit → bot dispatch → click event arrives at Chromium →
 * React re-render mounting the panel) is typically 50–400ms under load, so
 * 2000ms gives the tail plenty of slack without making chat-post failures
 * slow to surface when the panel genuinely never opens (e.g. the toggle is
 * disabled because the meeting host restricted chat).
 */
const ENSURE_PANEL_OPEN_TIMEOUT_MS = 2000;

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
  // Fire-and-forget: the reader only needs the panel open so the
  // MutationObserver below has something to watch. The JS `.click()`
  // fallback inside `ensurePanelOpen` (plus the optional `trusted_click`
  // hint when `onEvent` is wired) runs synchronously; the async wait for
  // the message list to mount is irrelevant to the observer, which will
  // pick up the list insertion as a regular DOM mutation whenever it
  // lands. If the click is silently swallowed (isTrusted gate on a Meet
  // build that we're not signaling to the bot), the observer just stays
  // idle — the same failure mode as before this helper went async.
  void ensurePanelOpen();

  // Dedup across extract() calls. DOM-node identity is the primary key —
  // a `role="listitem"` is not reinstantiated once the panel is open, so
  // a WeakSet on the node is sufficient for the common case. A secondary
  // content-hash set covers re-mounts (panel close → reopen): the node
  // identity is new, but the rendered sender+text+time triple is stable
  // enough to suppress a duplicate fire. `data-message-id` is preferred
  // when Meet exposes it, but it's not present on the live DOM today.
  const seenNodes = new WeakSet<Element>();
  const seenContentHashes = new Set<string>();

  let emittedCount = 0;
  let diagnosticEmitted = false;
  /**
   * Fire a one-shot `[ext]` diagnostic the first time we observe a
   * message list in which the listitem rows do NOT carry the
   * `data-message-id` attribute that {@link chatSelectors.MESSAGE_NODE}'s
   * primary clause depends on. That's the exact drift signature this
   * reader's fallback path exists to handle — the diagnostic gives an
   * operator enough DOM structure (attrs on the first listitem, nearby
   * aria-labels) to write a more precise selector next time.
   *
   * Fixture tests (which carry `data-message-id` on every listitem) never
   * trip this branch, so the diagnostic doesn't pollute their event
   * streams.
   */
  const maybeEmitReaderDiagnostic = (): void => {
    if (diagnosticEmitted) return;
    const structuralItems = document.querySelectorAll(
      '[role="list"][aria-label*="message" i] [role="listitem"]',
    );
    if (structuralItems.length === 0) return;

    let structuralOnlyItem: Element | null = null;
    for (const item of Array.from(structuralItems)) {
      if (!item.hasAttribute("data-message-id")) {
        structuralOnlyItem = item;
        break;
      }
    }
    // Fixture-shaped DOMs (every listitem has data-message-id) never emit
    // the diagnostic — selector drift is the only case that trips it.
    if (!structuralOnlyItem) return;
    diagnosticEmitted = true;

    const lists = document.querySelectorAll(chatSelectors.MESSAGE_LIST);
    const summarizeItem = (el: Element): string => {
      const attrs = Array.from(el.attributes)
        .map((a) => `${a.name}${a.value ? `="${a.value.slice(0, 40)}"` : ""}`)
        .join(" ");
      const descendantAttrs = Array.from(el.querySelectorAll("[aria-label]"))
        .slice(0, 4)
        .map((child) => {
          const label = (child.getAttribute("aria-label") ?? "")
            .replace(/\s+/g, " ")
            .slice(0, 40);
          return `${child.tagName}[${label}]`;
        })
        .join(", ");
      return `<${el.tagName} ${attrs}>${descendantAttrs ? ` aria-children: ${descendantAttrs}` : ""}`;
    };

    const listLabels = Array.from(lists)
      .map((el) => el.getAttribute("aria-label") ?? "<no-label>")
      .join(", ");
    const msg =
      `chat-reader: structural fallback engaged — ` +
      `lists(${lists.length})=[${listLabels}] ` +
      `structuralItems=${structuralItems.length} ` +
      `firstItem=${summarizeItem(structuralOnlyItem)}`;
    try {
      opts.onEvent({ type: "diagnostic", level: "info", message: msg });
    } catch {
      // Never let a diagnostic emit throw kill the reader.
    }
  };

  /**
   * Best-effort sender + text extraction. Preferred path is the fixture's
   * data-* attrs; structural fallbacks cover live Meet, which exposes
   * neither. Returns `null` if the listitem doesn't carry both fields.
   */
  const extractFields = (
    msg: Element,
  ): { fromName: string; text: string; timestamp: string } | null => {
    // Preferred: explicit markers on the fixture shape.
    let fromName = (
      msg.querySelector(chatSelectors.MESSAGE_SENDER)?.textContent ?? ""
    ).trim();
    let text = (
      msg.querySelector(chatSelectors.MESSAGE_TEXT)?.textContent ?? ""
    ).trim();

    if (!fromName || !text) {
      // Fallback: walk the listitem's text-bearing children. Meet renders
      // a per-message row as <sender, timestamp> followed by one or more
      // <bubble> text nodes. Collect all direct+nested text while skipping
      // pure-whitespace nodes and the <time> subtree.
      const lines: string[] = [];
      const collect = (node: Element): void => {
        for (const child of Array.from(node.children)) {
          const tag = child.tagName;
          if (tag === "TIME" || tag === "SCRIPT" || tag === "STYLE") continue;
          if (child.children.length === 0) {
            const raw = (child.textContent ?? "").trim();
            if (raw.length > 0) lines.push(raw);
          } else {
            collect(child);
          }
        }
      };
      collect(msg);
      if (lines.length >= 2) {
        // Heuristic: first non-empty line is the sender, remaining lines
        // (joined with newlines) are the message body. Covers the common
        // Meet rendering of sender+timestamp on one "row" followed by the
        // message bubble.
        if (!fromName) fromName = lines[0];
        if (!text) text = lines.slice(1).join("\n");
      }
    }

    if (!fromName || !text) return null;

    const timestamp =
      msg.querySelector(chatSelectors.MESSAGE_TIMESTAMP)?.getAttribute(
        "datetime",
      ) ?? "";

    return { fromName, text, timestamp };
  };

  const extract = (node: Element, isBackfill = false): void => {
    // Probe — don't require membership in the current MESSAGE_NODE set; the
    // structural fallback inside `chatSelectors.MESSAGE_NODE` is a descendant
    // selector, so `matches()` won't return `true` even when a passed-in
    // node is actually a listitem. Check both the strict (data-attr) and
    // structural paths explicitly.
    const isStructuralListItem =
      node.getAttribute?.("role") === "listitem" &&
      node.closest('[role="list"][aria-label*="message" i]') !== null;
    const messages: Element[] =
      node.matches?.(chatSelectors.MESSAGE_NODE) || isStructuralListItem
        ? [node]
        : Array.from(node.querySelectorAll(chatSelectors.MESSAGE_NODE));

    for (const msg of messages) {
      if (seenNodes.has(msg)) continue;
      seenNodes.add(msg);

      const fields = extractFields(msg);
      if (!fields) continue;

      const { fromName, text, timestamp } = fields;

      // Authoritative self-flag wins; otherwise match by display name.
      // Meet's live DOM does not currently emit `data-is-self`, so the
      // name-match branch is the one that fires in practice.
      const senderEl = msg.querySelector(chatSelectors.MESSAGE_SENDER);
      const isSelf =
        msg.getAttribute("data-is-self") === "true" ||
        senderEl?.getAttribute("data-is-self") === "true" ||
        fromName === opts.selfName;
      if (isSelf) continue;

      // Content hash covers panel close → reopen remounts where the DOM
      // node identity changes but the rendered message is the same.
      const contentHash = `${fromName}\u0001${timestamp}\u0001${text}`;
      if (seenContentHashes.has(contentHash)) continue;
      seenContentHashes.add(contentHash);

      // Sender-side id when Meet exposes one; otherwise fall back to the
      // display name (stable enough within a meeting).
      const fromId = senderEl?.getAttribute("data-sender-id") ?? fromName;

      const event: ExtensionInboundChatMessage = {
        type: "chat.inbound",
        meetingId: opts.meetingId,
        // Emit bot-observation time, not Meet's sender-side timestamp. Keeps
        // event ordering consistent with the rest of the pipeline.
        timestamp: new Date().toISOString(),
        fromId,
        fromName,
        text,
        // True only for the initial replay of pre-existing DOM messages
        // during reader attach. Downstream consumers use this to skip
        // wake-the-agent paths (Tier 2 LLM check) for history entries
        // that would otherwise burn the debounce slot a real live
        // message is about to need.
        ...(isBackfill ? { isBackfill: true as const } : {}),
      };
      emittedCount += 1;
      try {
        opts.onEvent(event);
      } catch {
        // Don't let a subscriber throw kill the observer loop.
      }
    }
  };

  // Backfill any messages already in the DOM when the reader attaches —
  // otherwise we'd miss the pre-existing chat history. Mark these events
  // with `isBackfill: true` so the chat-opportunity detector skips Tier 2
  // on them; a pre-existing history entry consuming the debounce slot
  // would silently drop the first real live message that lands inside
  // the debounce window.
  maybeEmitReaderDiagnostic();
  for (const existing of document.querySelectorAll(
    chatSelectors.MESSAGE_NODE,
  )) {
    extract(existing, true);
  }

  const observer = new MutationObserver((mutations) => {
    // Re-probe the diagnostic on each mutation batch until it fires — the
    // chat list mounts asynchronously after `ensurePanelOpen()` clicks the
    // toggle, and the backfill probe above often runs before the list is
    // in the DOM.
    maybeEmitReaderDiagnostic();
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
      if (emittedCount === 0) {
        // Trailing diagnostic so an operator reading `docker logs` after a
        // silent session sees that the reader attached but saw nothing —
        // typically a selector-drift signal that the primary MESSAGE_NODE
        // clause no longer matches. Bounded emission (one per reader
        // lifecycle) keeps the bot log quiet on healthy sessions.
        try {
          opts.onEvent({
            type: "diagnostic",
            level: "info",
            message:
              "chat-reader: stopped without emitting any chat.inbound events",
          });
        } catch {
          // Never let a diagnostic emit throw kill teardown.
        }
      }
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
 *
 * When `opts.onEvent` is provided, two extra extension→bot signals are
 * emitted so the bot can drive the composer + send via real X-server
 * events (required by any Meet build that enforces `event.isTrusted` on
 * the corresponding controls):
 *
 * 1. The composer is focused and a `trusted_type` event is emitted so the
 *    bot can xdotool-type the text as real keystrokes. We deliberately
 *    skip the native-setter `.value = text` + synthetic `input` path when
 *    `onEvent` is wired: xdotool types on top of whatever is already in
 *    the composer, so populating it synthetically first would produce
 *    doubled text ("hellohello"). The native-setter path is kept as a
 *    fallback only for the `onEvent`-less case (jsdom tests and any Meet
 *    build where synthetic input is accepted).
 *
 *    After emitting, we wait {@link trustedTypeDurationMs}(`text.length`)
 *    so the (async) xdotool keystrokes have time to land before the send-
 *    button click is dispatched. A fixed 250ms window was too short for
 *    messages longer than ~10 characters (xdotool's default per-keystroke
 *    delay is 25ms). The wait formula is the single source of truth for
 *    the extension wait, the bot's xdotool kill timer, and the bot /
 *    daemon `send_chat` reply timers — see the helper's definition in
 *    `contracts/native-messaging.ts`.
 *
 * 2. Before the send-button `.click()`, a `trusted_click` is emitted for
 *    the button's screen coordinates. This mirrors the panel-toggle fix
 *    in {@link ensurePanelOpen} and the admission-button fix in
 *    `features/join.ts` — by symmetry with other `isTrusted`-gated
 *    buttons in Meet's UI, we expect the send button is also gated, so a
 *    bare JS `.click()` from a content script would be silently ignored.
 *    The `.click()` call is kept as a fallback for the jsdom test
 *    harness and any Meet build that does not enforce `isTrusted` on send.
 */
export async function sendChat(
  text: string,
  opts?: EnsurePanelOpenOptions,
): Promise<void> {
  if (text.length > MEET_CHAT_MAX_LENGTH) {
    throw new Error(
      `text exceeds Meet chat limit of ${MEET_CHAT_MAX_LENGTH} characters (got ${text.length})`,
    );
  }

  const input = document.querySelector<HTMLTextAreaElement>(
    chatSelectors.INPUT,
  );
  if (!input) {
    throw new Error(
      `sendChat: chat input not found (selector: ${chatSelectors.INPUT}; ${describeComposerSearch()})`,
    );
  }

  if (opts?.onEvent) {
    // When an `onEvent` sink is wired we drive the composer entirely via
    // xdotool-type: focus the field first so the X-server keystrokes land
    // on the right element, then emit `trusted_type` and wait for the
    // bot's async typing to complete before we dispatch the send click.
    //
    // We deliberately do NOT take the synthetic-setter path below in this
    // branch. xdotool appends to whatever is in the focused field, so if
    // we pre-populated the composer with `.value = text` the xdotool-
    // typed text would land on top and produce doubled output
    // ("hellohello"). Relying solely on xdotool keeps the produced text
    // correct on any Meet build that enforces `event.isTrusted` on the
    // composer — which is the only reason we invoke xdotool in the first
    // place.
    //
    // The wait scales with text length because xdotool's per-keystroke
    // delay (25ms) dominates: a 100-char message takes ~2.5s of real-time
    // typing. A fixed 250ms was too short for anything longer than ~10
    // characters — the send button fired mid-type and posted a partial
    // message.
    try {
      input.focus();
    } catch {
      // Some jsdom / degraded DOM builds throw on .focus(); the native-
      // messaging emit below is still safe (the bot will type into
      // whatever is focused on the Xvfb display) and the test harness
      // does not require focus to succeed.
    }
    opts.onEvent({ type: "trusted_type", text });
    // Wait exactly as long as xdotool needs to type the text — the
    // shared helper returns `text.length * 25ms + 250ms` by default and
    // stays in sync with the bot's xdotool kill timer and the bot/daemon
    // `send_chat` timeouts that scale off the same formula.
    const waitMs = trustedTypeDurationMs(text.length);
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  } else {
    // No `onEvent` sink — we can't drive xdotool, so fall back to the
    // synthetic-setter path. Meet's composer is a React-controlled
    // textarea. React 16+ installs an instance-level property-descriptor
    // interceptor (`inputValueTracking`) that hijacks `.value = ...`:
    // when the synthetic `input` event fires, React compares the DOM
    // value to its internal tracker and — because the interceptor
    // updated the tracker in lockstep with the assignment — observes no
    // change and skips the onChange dispatch. The result is a composer
    // that visually shows the text but never commits to React state, so
    // Send posts empty/stale content.
    //
    // The workaround is Playwright's `page.fill` trick: grab the native
    // setter off `HTMLTextAreaElement.prototype` (which the React
    // interceptor shadows at the instance level) and invoke it with
    // `.call(input, text)`. That routes through the prototype setter
    // without touching React's tracker, so the subsequent `input` event
    // fires with a genuine value change and onChange runs normally. We
    // still dispatch the synthetic `input` event ourselves — React
    // relies on it as the trigger for onChange even after the value has
    // been updated.
    //
    // If the native setter isn't resolvable for any reason (e.g. a jsdom
    // build that doesn't expose the prototype descriptor), fall back to
    // the direct `.value = ...` assignment. That path is adequate for
    // the test harness and any pre-React-tracker Meet build.
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(input, text);
    } else {
      input.value = text;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const sendButton = document.querySelector<HTMLButtonElement>(
    chatSelectors.SEND_BUTTON,
  );
  if (!sendButton) {
    throw new Error(
      `sendChat: send button not found (selector: ${chatSelectors.SEND_BUTTON})`,
    );
  }

  // Compute screen coords and emit the xdotool hint before the JS click.
  // Math matches `ensurePanelOpen` + `features/join.ts`'s admission-button
  // block — see the long comment in `features/join.ts` for the assumptions
  // about screenX/Y, chrome offsets, and DPI. Production Xvfb pins the
  // window to (0,0) with no bottom chrome, so the `outerHeight - innerHeight`
  // delta is the top chrome offset.
  if (opts?.onEvent) {
    try {
      const rect = sendButton.getBoundingClientRect();
      const win = opts.window ?? (globalThis as typeof globalThis);
      const chromeOffsetY = Math.max(
        0,
        (win as typeof globalThis).outerHeight -
          (win as typeof globalThis).innerHeight,
      );
      const screenX = Math.round(
        ((win as typeof globalThis).screenX ?? 0) + rect.left + rect.width / 2,
      );
      const screenY = Math.round(
        ((win as typeof globalThis).screenY ?? 0) +
          chromeOffsetY +
          rect.top +
          rect.height / 2,
      );
      opts.onEvent({ type: "trusted_click", x: screenX, y: screenY });
    } catch {
      // If the rect or window shape is bogus, fall through to the JS click
      // fallback rather than swallowing the whole send attempt.
    }
  }

  sendButton.click();
}

/**
 * Optional inputs accepted by {@link postConsentMessage} / {@link ensurePanelOpen}
 * so the join flow can forward its `onEvent` sink and `window` metadata
 * through. When omitted, `ensurePanelOpen` falls back to a JS `.click()`
 * alone — adequate for the jsdom test harness and any Meet build that does
 * not enforce `isTrusted` on the toggle.
 */
interface EnsurePanelOpenOptions {
  /**
   * Sink for extension→bot events. When provided, `ensurePanelOpen` emits a
   * `trusted_click` with screen-space coordinates for the toggle so the bot
   * can dispatch a real X-server click via xdotool (Meet gates the toggle
   * on `event.isTrusted`, so a bare JS `.click()` is silently ignored).
   */
  onEvent?: (msg: ExtensionToBotMessage) => void;
  /**
   * Window used to compute screen-space coordinates. Mirrors the shape in
   * {@link "../features/join.js"}'s `RunJoinFlowOptions.window`. Defaults to
   * the live `window` when omitted.
   */
  window?: {
    screenX: number;
    screenY: number;
    outerHeight: number;
    innerHeight: number;
  };
}

/**
 * Ensure the chat panel is open and then call {@link sendChat}.
 *
 * Invoked by the join flow to drop the consent notice once the bot is in
 * the meeting. Safe to call exactly once per session — if the composer is
 * already visible, we skip the panel-toggle click (clicking again would
 * close the panel).
 */
export async function postConsentMessage(
  text: string,
  opts?: EnsurePanelOpenOptions,
): Promise<void> {
  // Awaiting here is load-bearing: the panel-toggle `trusted_click` is a
  // fire-and-forget native-messaging emit that races xdotool's X-server
  // click against `sendChat`'s synchronous INPUT query. In production, the
  // JS `.click()` fallback is rejected by Meet's isTrusted gate, so the
  // composer only mounts after xdotool's click lands tens of ms later.
  // Without the await, `sendChat` threw `"chat input not found"` before
  // the panel had a chance to open.
  await ensurePanelOpen(opts);
  await sendChat(text, opts);
}

/**
 * Click the chat toggle once if the panel isn't already open and wait for
 * the message-list container to mount. Detects open state via the
 * message-list container (mounted even when empty), not individual message
 * nodes which require at least one message to exist.
 *
 * When `opts.onEvent` is provided and the panel is closed, emits a
 * `trusted_click` for the toggle button's screen coordinates before
 * attempting the JS `.click()` fallback. This mirrors the admission-button
 * fix in `features/join.ts` — Meet gates the chat panel toggle on
 * `event.isTrusted`, so a programmatic `.click()` from a content script
 * silently no-ops. Without the trusted click, the panel never opens, the
 * composer never mounts, and `sendChat` throws "chat input not found"
 * (swallowed by the caller as a diagnostic).
 *
 * ## Why this is async
 *
 * The `trusted_click` emit is fire-and-forget: the native-messaging frame
 * is queued into the bot's stdin and xdotool dispatches the X-server click
 * tens of ms later. Returning synchronously after the emit would let
 * {@link postConsentMessage} race the async panel-open against
 * {@link sendChat}'s synchronous INPUT query — in production (where the
 * isTrusted gate rejects the JS `.click()` fallback) the composer hasn't
 * mounted yet and `sendChat` throws immediately.
 *
 * To close the race we poll for {@link chatSelectors.INPUT} with a short
 * deadline ({@link ENSURE_PANEL_OPEN_TIMEOUT_MS}) via
 * {@link waitForSelector}. The composer is the thing `sendChat` actually
 * needs, so anchoring the wait on it keeps this function correct even
 * when Meet drifts the surrounding chrome (panel header renamed to
 * "In-call messages", `MESSAGE_LIST` aria-label changed, etc.). When
 * the panel was already open on entry the initial `document.querySelector`
 * returns synchronously, so the poll is a no-op on the fast path. If the
 * deadline expires we fall through silently — `sendChat` will surface
 * its own "chat input not found" diagnostic, which the join flow's
 * `try/catch` already handles.
 */
export async function ensurePanelOpen(
  opts?: EnsurePanelOpenOptions,
): Promise<void> {
  // Prefer the composer as the panel-open signal: if it's in the DOM,
  // `sendChat` will succeed regardless of the surrounding chrome.
  // `MESSAGE_LIST` is retained as a fallback so existing tests (which
  // mount only the list, not the composer, to drive the panel-already-
  // open branch) continue to work.
  if (
    document.querySelector(chatSelectors.INPUT) ||
    document.querySelector(chatSelectors.MESSAGE_LIST)
  ) {
    return;
  }
  const toggle = document.querySelector<HTMLButtonElement>(
    chatSelectors.PANEL_BUTTON,
  );
  if (!toggle) return;

  // Compute screen coords and emit the xdotool hint before the JS click.
  // Math matches `features/join.ts`'s admission-button block — see the long
  // comment there for the assumptions about screenX/Y, chrome offsets, and
  // DPI. Production Xvfb pins the window to (0,0) with no bottom chrome, so
  // the `outerHeight - innerHeight` delta is the top chrome offset.
  if (opts?.onEvent) {
    try {
      const rect = toggle.getBoundingClientRect();
      const win = opts.window ?? (globalThis as typeof globalThis);
      const chromeOffsetY = Math.max(
        0,
        (win as typeof globalThis).outerHeight -
          (win as typeof globalThis).innerHeight,
      );
      const screenX = Math.round(
        ((win as typeof globalThis).screenX ?? 0) + rect.left + rect.width / 2,
      );
      const screenY = Math.round(
        ((win as typeof globalThis).screenY ?? 0) +
          chromeOffsetY +
          rect.top +
          rect.height / 2,
      );
      opts.onEvent({ type: "trusted_click", x: screenX, y: screenY });
    } catch {
      // If the rect or window shape is bogus, fall through to the JS click
      // fallback rather than swallowing the whole panel-open attempt.
    }
  }

  try {
    toggle.click();
  } catch {
    // Click can fail if the button is detached mid-flight; let the caller
    // surface the downstream selector error when the composer isn't
    // findable.
  }

  // Wait for the composer to mount — the thing `sendChat` actually
  // queries. In jsdom tests the JS `.click()` fallback mounts the
  // composer synchronously before we reach this line, so
  // `waitForSelector`'s synchronous first check resolves without ever
  // attaching a MutationObserver. In production Meet the click is queued
  // through xdotool and the composer mounts a beat later; the observer
  // catches that mutation and resolves before the deadline. If the
  // composer never appears (e.g. host-restricted chat, or the panel
  // failed to open) swallow the timeout — `sendChat` will surface its
  // own "chat input not found" error through the join flow's diagnostic
  // wrapper.
  //
  // Anchoring on the composer (not the message list) keeps this correct
  // across Meet's "Continuous chat is turned off" / "In-call messages"
  // DOM where the list's aria-label no longer matches the old selector.
  // The composer's `aria-label^="Send a message"` has been stable across
  // that transition.
  try {
    await waitForSelector(chatSelectors.INPUT, ENSURE_PANEL_OPEN_TIMEOUT_MS);
  } catch {
    // timeout — handled by downstream sendChat
  }
}
