// Pure projection from chat state onto the flat `TranscriptItem[]` list
// the virtualized transcript consumes. No React, no DOM — the rules here
// mirror the rendering logic currently embedded inside
// `AssistantPageClient.tsx` (messages loop + trailers block) so the
// forthcoming Transcript component can render a single flat list
// without re-implementing those projection rules.

import { dedupeDisplayMessages, type DisplayMessage } from "@/domains/chat/utils/reconcile";
import type {
  MessageItem,
  PendingContactRequestItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";

export interface BuildTranscriptItemsInput {
  messages: DisplayMessage[];
  pendingSecret: { requestId: string } | null;
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
  errorNotice: string | null;
  showOnboardingChoice?: boolean;
}

/**
 * Project the chat state into an ordered flat list of transcript items.
 *
 * Rules (mirror the JSX in `AssistantPageClient.tsx`):
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
 *        c. `ErrorItem` when `errorNotice` is a non-empty string.
 *
 * Pending confirmations are not standalone rows: every confirmation is bound
 * to a tool call and renders inline on that tool call's chip via
 * `toolCall.pendingConfirmation`.
 *
 * Every returned item carries a non-empty, distinct `key`.
 */
export function buildTranscriptItems(
  input: BuildTranscriptItemsInput,
): TranscriptItem[] {
  const {
    messages,
    pendingSecret,
    pendingContactRequest,
    isThinking,
    errorNotice,
  } = input;

  const items: TranscriptItem[] = [];

  for (const message of dedupeDisplayMessages(messages)) {
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
