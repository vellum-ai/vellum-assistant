// Pure projection from chat state onto the flat `TranscriptItem[]` list
// the virtualized transcript consumes. No React, no DOM — takes chat
// messages + interaction state and emits a flat item array that the
// Transcript component renders via a virtualised list.

import type {
  DisplayMessage,
  EphemeralMetaResult,
} from "@/domains/chat/types/types";
import type {
  CreditsUpsellItem,
  MessageItem,
  PendingContactRequestItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";
import { isCreditsExhaustedProviderError } from "@/domains/chat/utils/error-classification";

export interface BuildTranscriptItemsInput {
  messages: DisplayMessage[];
  pendingSecret: { requestId: string } | null;
  pendingConfirmation: { requestId: string } | null;
  pendingContactRequest?: {
    requestId: string;
    channel?: string;
    placeholder?: string;
    defaultValue?: string;
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
  /**
   * Whether the org's credit balance is currently exhausted (from
   * `useBillingBalanceStatus().isExhausted`). Drives both credits-upsell
   * surfaces of the projection: the per-row card substitution for
   * credits-exhausted provider-error rows and the proactive tail card
   * appended after the message-derived items. When false, tagged rows keep
   * the normal message rendering, whose persisted assistant-voice text reads
   * as historical context. That covers both a balance that has since been
   * topped up and contexts where the billing hook is inert (self-hosted/gated
   * assistants, no platform session), so the card, which renders nothing when
   * platform billing is unreachable, is never substituted for a visible
   * bubble it cannot replace.
   */
  creditsExhausted?: boolean;
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
  if (cached) {
    return cached;
  }
  const item: MessageItem = {
    kind: "message",
    key: message.clientMessageId ?? message.id,
    message,
  };
  messageItemCache.set(message, item);
  return item;
}

/** Same ref-keyed memoization as {@link toMessageItem}, for the upsell items
 *  substituted in place of credits-exhausted provider-error rows. */
const creditsUpsellItemCache = new WeakMap<DisplayMessage, CreditsUpsellItem>();

function toCreditsUpsellItem(message: DisplayMessage): CreditsUpsellItem {
  const cached = creditsUpsellItemCache.get(message);
  if (cached) {
    return cached;
  }
  const item: CreditsUpsellItem = {
    kind: "creditsUpsell",
    key: `credits-upsell-${message.clientMessageId ?? message.id}`,
    message,
  };
  creditsUpsellItemCache.set(message, item);
  return item;
}

/** Singleton for the proactive exhausted-balance card appended after the
 *  message-derived items. Not tied to any message row; the stable reference
 *  keeps `TranscriptRow`'s `memo()` effective across rebuilds. */
const PROACTIVE_CREDITS_UPSELL_ITEM: CreditsUpsellItem = {
  kind: "creditsUpsell",
  key: "credits-upsell-proactive",
};

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

    // While the balance is currently exhausted (`creditsExhausted`),
    // persisted credits-exhausted provider-error rows render as the friendly
    // upsell card instead of a plain persona bubble. The row itself stays in
    // `messages` (history and the LLM context keep the text); only its
    // transcript rendering is substituted. Classification goes through the
    // shared `isCreditsExhaustedProviderError`, so a bare
    // `PROVIDER_BILLING` code with no category substitutes too. Provider
    // errors of any other category, untagged rows, and tagged rows without
    // the live flag keep the normal message rendering.
    if (
      input.creditsExhausted &&
      isCreditsExhaustedProviderError(message.providerError)
    ) {
      items.push(toCreditsUpsellItem(message));
      continue;
    }

    items.push(toMessageItem(message));
  }

  // While the balance is exhausted, the proactive upsell card lands directly
  // after the message rows of an open conversation, so the credit wall shows
  // before the next send fails. Empty conversations render the chat empty
  // state (which mounts its own card), not the transcript, so a message-less
  // build appends nothing. In-flight turns suppress the card so it never
  // sits under the live progress indicator; the turn-settled billing refetch
  // re-shows it as soon as the turn ends. Deduping against a trailing
  // substituted card here, before trailers are pushed below (thinking slot,
  // pending prompts, onboarding choice), means a just-failed turn's card can
  // never be doubled.
  if (
    input.creditsExhausted &&
    !input.turnActive &&
    messages.length > 0 &&
    items[items.length - 1]?.kind !== "creditsUpsell"
  ) {
    items.push(PROACTIVE_CREDITS_UPSELL_ITEM);
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
      defaultValue: pendingContactRequest.defaultValue,
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
