// Projection from chat state onto the flat, ordered `TranscriptItem[]` list
// the transcript renders. No React, no DOM — takes chat messages + interaction
// state and emits the flat item array, unit-testable in isolation.
//
// `buildTranscriptItems` re-runs on every streaming token (the messages array
// is replaced on each delta), so message-item wrappers are memoized by message
// identity: an unchanged row hands back the *same* `MessageItem` reference,
// which lets the memoized `TranscriptRow` skip it while the streaming row
// updates. See `messageItemFor`.

import type {
  DisplayMessage,
  EphemeralMetaResult,
} from "@/domains/chat/types/types";
import type {
  MessageItem,
  PendingContactRequestItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";

export interface BuildTranscriptItemsInput {
  messages: DisplayMessage[];
  pendingSecret: { requestId: string } | null;
  pendingConfirmation: { requestId: string } | null;
  pendingContactRequest?: {
    requestId: string;
    channel?: string;
    placeholder?: string;
    label?: string;
    description?: string;
    role?: string;
  } | null;
  isThinking: boolean;
  /** Daemon-provided activity label for the thinking indicator. */
  thinkingLabel?: string | null;
  /** Ephemeral local meta-command results (e.g. /clean, /status), rendered at
   *  the transcript tail. Not persisted; cleared on the next send/switch. */
  ephemeralMetaResults?: EphemeralMetaResult[];
  showOnboardingChoice?: boolean;
}

// ---------------------------------------------------------------------------
// Message-item identity cache
// ---------------------------------------------------------------------------

/**
 * Message-item wrappers keyed by the `DisplayMessage` they wrap.
 *
 * The transcript re-derives its item list on every streaming token, but
 * `sanitizeDisplayMessages` preserves the identity of rows it does not change.
 * Returning the same wrapper for an unchanged message keeps the `MessageItem`
 * reference (and so the `TranscriptRow` `item` prop) stable across that
 * rebuild, so the memoized row skips it — only the row whose `DisplayMessage`
 * actually changed (the streaming one) re-renders.
 *
 * A `WeakMap` keyed by object identity is idempotent and safe under React's
 * concurrent re-renders (no render-phase ref writes), and an entry is collected
 * once its message drops out of state.
 */
const messageItemCache = new WeakMap<DisplayMessage, MessageItem>();

function messageItemFor(message: DisplayMessage): MessageItem {
  const cached = messageItemCache.get(message);
  if (cached) return cached;
  const item: MessageItem = { kind: "message", key: message.id, message };
  messageItemCache.set(message, item);
  return item;
}

/**
 * Project the chat state into an ordered flat list of transcript items.
 *
 * Rules:
 *
 *   1. For each `DisplayMessage` in order, emit a `MessageItem` with
 *      `key = message.id`. Inline surfaces attached to a message are
 *      rendered within the message body by `TranscriptMessageBody` via
 *      `contentOrder` — they are NOT separate transcript rows. Tool calls
 *      stay inside the `MessageItem` — the Transcript component flattens
 *      them at render time.
 *
 *   2. After the last message, emit trailers in this exact order:
 *        a. `ThinkingItem` when `isThinking`.
 *        b. `PendingSecretItem` when `pendingSecret` is set.
 *        c. `PendingConfirmationItem` when `pendingConfirmation` is set.
 * Every returned item carries a non-empty, distinct `key`.
 */
export function buildTranscriptItems(
  input: BuildTranscriptItemsInput,
): TranscriptItem[] {
  const {
    messages,
    pendingSecret,
    pendingConfirmation,
    pendingContactRequest,
    isThinking,
  } = input;

  const items: TranscriptItem[] = [];

  for (const message of messages) {
    // Subagent notification messages are injected by the daemon as user-role
    // messages for state reconstruction (history.ts extracts them). They
    // pass through as normal `MessageItem`s so reconciliation sees the full
    // row context — `TranscriptMessageBody` branches on `isSubagentNotification`
    // and renders a narrow system pill instead of the user bubble.
    const isQueuedUser =
      message.role === "user" && message.queueStatus === "queued";

    if (isQueuedUser) {
      continue;
    }

    items.push(messageItemFor(message));
  }

  for (const result of input.ephemeralMetaResults ?? []) {
    items.push({
      kind: "ephemeralMeta",
      key: `meta-${result.id}`,
      result,
    });
  }

  if (isThinking) {
    items.push({
      kind: "thinking",
      key: "thinking",
      ...(input.thinkingLabel ? { label: input.thinkingLabel } : {}),
    });
  }

  if (pendingSecret) {
    items.push({
      kind: "pendingSecret",
      key: `secret-${pendingSecret.requestId}`,
      requestId: pendingSecret.requestId,
    });
  }

  if (pendingConfirmation) {
    items.push({
      kind: "pendingConfirmation",
      key: `confirmation-${pendingConfirmation.requestId}`,
      requestId: pendingConfirmation.requestId,
    });
  }

  if (pendingContactRequest) {
    const item: PendingContactRequestItem = {
      kind: "pendingContactRequest",
      key: `contact-request-${pendingContactRequest.requestId}`,
      requestId: pendingContactRequest.requestId,
      channel: pendingContactRequest.channel,
      placeholder: pendingContactRequest.placeholder,
      label: pendingContactRequest.label,
      description: pendingContactRequest.description,
      role: pendingContactRequest.role,
    };
    items.push(item);
  }

  if (input.showOnboardingChoice) {
    items.push({
      kind: "onboardingChoice",
      key: "onboarding-choice",
    });
  }

  return items;
}
