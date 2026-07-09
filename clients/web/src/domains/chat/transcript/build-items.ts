// Pure projection from chat state onto the flat `TranscriptItem[]` list
// the virtualized transcript consumes. No React, no DOM — takes chat
// messages + interaction state and emits a flat item array that the
// Transcript component renders via a virtualised list.

import type { ConversationContentBlock } from "@vellumai/assistant-api";

import type {
  DisplayMessage,
  EphemeralMetaResult,
} from "@/domains/chat/types/types";
import type {
  MessageItem,
  PendingContactRequestItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";
import { filterMessageSurfaces } from "@/domains/chat/utils/map-message-surfaces";

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
  /**
   * Client half of the `skill-creation-card` kill-switch (the assistant half
   * gates card *insertion*). When false, `skill_card` surfaces are stripped
   * from every message before projection: a mixed message just loses those
   * surface blocks, and a message left with nothing renderable is skipped
   * entirely. Gating here — rather than only returning `null` inside
   * `SkillCreatedCard` — matters because the message row's surface wrapper
   * and hover-action trailer render unconditionally, so a persisted
   * card-only message would otherwise leave a blank ~24px assistant row.
   * Omitted/undefined behaves as enabled.
   */
  skillCardsEnabled?: boolean;
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
 * Flag-off skill-card projection cache, keyed by the original message ref
 * (same identity discipline as `messageItemCache` — see its comment for why
 * reference stability matters at streaming rebuild rates). `null` marks
 * "nothing left to render: skip the row". Only consulted while the
 * skill-card flag is off, so a runtime flag flip can never serve a stale
 * projection — the flag-on path bypasses this cache entirely.
 */
const skillCardStripCache = new WeakMap<
  DisplayMessage,
  DisplayMessage | null
>();

/**
 * Strip `skill_card` surfaces from a message for the flag-off kill-switch.
 * Returns the message untouched when it carries no skill cards, a stripped
 * copy (surfaces / contentOrder / contentBlocks filtered in lockstep) when
 * other renderable content remains, or `null` when the skill cards were the
 * only renderable content — the caller drops the row entirely so no blank
 * assistant row (empty surface wrapper + hover-action trailer) is left
 * behind for persisted card-only messages.
 */
function withoutSkillCardSurfaces(
  message: DisplayMessage,
): DisplayMessage | null {
  const cached = skillCardStripCache.get(message);
  if (cached !== undefined) return cached;
  const stripped = filterMessageSurfaces(
    message,
    (s) => s.surfaceType !== "skill_card",
  );
  const result =
    stripped === message
      ? message
      : hasRenderableContent(stripped)
        ? stripped
        : null;
  skillCardStripCache.set(message, result);
  return result;
}

/**
 * Whether the transcript row for this message would still visibly render
 * anything. Checks the canonical `contentBlocks` projection (what
 * `TranscriptMessageBody` renders), the attachment / Slack regions, and —
 * defensively — the legacy positional arrays. Blank text/thinking runs do
 * not count: the daemon strips the `_surfaceFallback` text for
 * surface-capable clients, so a card-only message has none of these.
 */
function hasRenderableContent(message: DisplayMessage): boolean {
  return Boolean(
    message.contentBlocks?.some(isRenderableBlock) ||
      message.surfaces?.length ||
      message.attachments?.length ||
      message.slackMessage ||
      message.toolCalls?.length ||
      message.textSegments?.some((s) => s.trim().length > 0) ||
      message.thinkingSegments?.some((s) => s.trim().length > 0),
  );
}

function isRenderableBlock(block: ConversationContentBlock): boolean {
  if (block.type === "text") return block.text.trim().length > 0;
  if (block.type === "thinking") return block.thinking.trim().length > 0;
  // tool_use / surface / attachment blocks always carry visible content.
  return true;
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
 *      When `skillCardsEnabled` is false, `skill_card` surfaces are stripped
 *      before projection and a message left with nothing renderable is
 *      skipped (see `withoutSkillCardSurfaces`).
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

    // skill-creation-card kill-switch (see `skillCardsEnabled`). Like the
    // notification suppression above this is projection-only — `messages`
    // state keeps the original row.
    const projected =
      input.skillCardsEnabled === false
        ? withoutSkillCardSurfaces(message)
        : message;
    if (projected === null) {
      continue;
    }

    items.push(toMessageItem(projected));
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
