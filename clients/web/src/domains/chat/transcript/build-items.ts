// Pure projection from chat state onto the flat `TranscriptItem[]` list
// the virtualized transcript consumes. No React, no DOM — takes chat
// messages + interaction state and emits a flat item array that the
// Transcript component renders via a virtualised list.

import type { DisplayMessage } from "@/domains/chat/types/types";
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
  /** Human-readable label when the daemon auto-routed to a different inference profile. */
  autoRoutedProfileLabel?: string | null;
  showOnboardingChoice?: boolean;
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
    // should not render as user bubbles. Matches macOS ChatVisibleMessageFilter.
    if (message.isSubagentNotification) {
      continue;
    }

    const isQueuedUser =
      message.role === "user" && message.queueStatus === "queued";

    if (isQueuedUser) {
      continue;
    }

    const messageItem: MessageItem = {
      kind: "message",
      key: message.id,
      message,
    };
    items.push(messageItem);
  }

  if (input.autoRoutedProfileLabel) {
    items.push({
      kind: "profileAutoRouted",
      key: "profile-auto-routed",
      profileLabel: input.autoRoutedProfileLabel,
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
