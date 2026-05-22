// Pure projection from chat state onto the flat `TranscriptItem[]` list
// the virtualized transcript consumes. No React, no DOM — the rules here
// mirror the rendering logic currently embedded inside
// `AssistantPageClient.tsx` (messages loop + trailers block) so the
// forthcoming Transcript component can render a single flat list
// without re-implementing those projection rules.

import { dedupeDisplayMessages, type DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import type {
  MessageItem,
  PendingContactRequestItem,
  QueuedMarkerItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types.js";

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
  errorNotice: string | null;
  showOnboardingChoice?: boolean;
}

/**
 * Project the chat state into an ordered flat list of transcript items.
 *
 * Rules (mirror the JSX in `AssistantPageClient.tsx`):
 *
 *   1. For each `DisplayMessage` in order, emit a `MessageItem` with
 *      `key = message.stableId`. Inline surfaces attached to a message
 *      are rendered within the message body by `TranscriptMessageBody`
 *      via `contentOrder` — they are NOT separate transcript rows.
 *      Tool calls stay inside the `MessageItem` — the Transcript
 *      component flattens them at render time.
 *
 *   2. After the last message, emit trailers in this exact order:
 *        a. `ThinkingItem` when `isThinking`.
 *        b. `PendingSecretItem` when `pendingSecret` is set.
 *        c. `PendingConfirmationItem` when `pendingConfirmation` is set.
 *        d. `ErrorItem` when `errorNotice` is a non-empty string.
 *
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
    errorNotice,
  } = input;

  const items: TranscriptItem[] = [];

  // Count queued user messages so we can collapse them into a single marker.
  const queuedCount = messages.filter(
    (m) => m.role === "user" && m.queueStatus === "queued",
  ).length;
  let markerInserted = false;

  for (const message of dedupeDisplayMessages(messages)) {
    // Subagent notification messages are injected by the daemon as user-role
    // messages for state reconstruction (history.ts extracts them). They
    // should not render as user bubbles. Matches macOS ChatVisibleMessageFilter.
    if (message.isSubagentNotification) {
      continue;
    }

    const isQueuedUser =
      message.role === "user" && message.queueStatus === "queued";

    if (isQueuedUser && queuedCount > 0) {
      if (!markerInserted) {
        const marker: QueuedMarkerItem = {
          kind: "queuedMarker",
          key: "queued-marker",
          count: queuedCount,
        };
        items.push(marker);
        markerInserted = true;
      }
      continue;
    }

    const messageItem: MessageItem = {
      kind: "message",
      key: message.stableId,
      message,
    };
    items.push(messageItem);
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

  if (errorNotice && errorNotice.length > 0) {
    items.push({
      kind: "error",
      key: "error-notice",
      message: errorNotice,
    });
  }

  if (input.showOnboardingChoice) {
    items.push({
      kind: "onboardingChoice",
      key: "onboarding-choice",
    });
  }

  return items;
}
