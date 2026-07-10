// Pure projection from chat state onto the flat `TranscriptItem[]` list
// the virtualized transcript consumes. No React, no DOM — takes chat
// messages + interaction state and emits a flat item array that the
// Transcript component renders via a virtualised list.

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
  /**
   * Whether the assistant is busy on an in-flight turn at all (from
   * `isAssistantBusy`). While true, the thinking item is kept in the list even
   * when `isThinking` is false — rendered as an invisible fixed-height slot —
   * so the shimmering indicator fades in/out in place across the turn's
   * signal-ownership handoffs instead of inserting/removing a row (which read
   * as the transcript jumping). Omitted/false preserves the legacy behavior:
   * the item exists only while `isThinking`.
   */
  turnActive?: boolean;
  /** Daemon-provided activity label for the thinking indicator. */
  thinkingLabel?: string | null;
  /** Ephemeral local meta-command results (e.g. /clean, /status), rendered at
   *  the transcript tail. Not persisted; cleared on the next send/switch. */
  ephemeralMetaResults?: EphemeralMetaResult[];
  showOnboardingChoice?: boolean;
}

/**
 * Memoize the transcript item wrapper for a message by object identity.
 *
 * `buildTranscriptItems` re-runs on every streaming token (~20/sec). Without
 * memoization it mints a fresh `{ kind, key, message }` for every message,
 * defeating `TranscriptRow`'s `memo()` and re-rendering the entire list per
 * token. Caching by message ref means only the row whose message object
 * actually changed gets a new item — unchanged rows keep a stable reference
 * and skip rendering. Weak keys release naturally with their messages.
 *
 * The React `key` uses `clientMessageId ?? id` so the optimistic→server id
 * swap doesn't remount the row.
 */
const messageItemCache = new WeakMap<DisplayMessage, MessageItem>();

function toMessageItem(message: DisplayMessage): MessageItem {
  const cached = messageItemCache.get(message);
  if (cached) return cached;
  const item: MessageItem = {
    kind: "message",
    key: message.clientMessageId ?? message.id,
    message,
  };
  messageItemCache.set(message, item);
  return item;
}

/**
 * Project the chat state into an ordered flat list of transcript items.
 *
 * Rules:
 *
 *   1. For each `DisplayMessage` in order, emit a `MessageItem` (keyed by the
 *      stable client identity `clientMessageId ?? id`, memoized by message ref
 *      via `toMessageItem`). Inline surfaces attached to a message are rendered
 *      within the message body by `TranscriptMessageBody` via `contentOrder` —
 *      they are NOT separate transcript rows. Tool calls stay inside the
 *      `MessageItem` — the Transcript component flattens them at render time.
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
    // Daemon-injected run lifecycle notifications (subagent + ACP + any wake
    // trigger, i.e. user-role messages carrying subagentNotification /
    // acpNotification / backgroundEventNotification metadata) stay in `messages`
    // state so the LLM transcript and store rehydration still see them, but they
    // are internal scaffolding and are never rendered in the transcript — the run
    // surfaces through its inline card instead.
    if (
      message.isSubagentNotification ||
      message.isAcpNotification ||
      message.isBackgroundEventNotification
    ) {
      continue;
    }

    // Queued user messages surface via the queue drawer, not the transcript.
    const isQueuedUser =
      message.role === "user" && message.queueStatus === "queued";

    if (isQueuedUser) {
      continue;
    }

    items.push(toMessageItem(message));
  }

  for (const result of input.ephemeralMetaResults ?? []) {
    items.push({
      kind: "ephemeralMeta",
      key: `meta-${result.id}`,
      result,
    });
  }

  if (isThinking || input.turnActive) {
    items.push({
      kind: "thinking",
      key: "thinking",
      active: isThinking,
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
