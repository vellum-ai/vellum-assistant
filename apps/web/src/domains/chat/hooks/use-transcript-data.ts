/**
 * Transcript data derivation — sanitises messages and projects them into
 * the flat `TranscriptItem[]` list the virtualised transcript renders.
 *
 * Reads messages from `useChatSessionStore`, interaction prompts from
 * `useInteractionStore`, and the auto-routed profile label from
 * `useTurnStore`. UI-level flags (`showThinking`, `thinkingLabel`) are
 * received as parameters from the caller's `useChatUIState` result to
 * avoid duplicating that hook's memoisation chain.
 *
 * @see buildTranscriptItems for the projection rules.
 * @see sanitizeDisplayMessages for the cleanup pipeline.
 */

import { useMemo } from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import { buildTranscriptItems } from "@/domains/chat/transcript/build-items";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import { sanitizeDisplayMessages } from "@/domains/chat/utils/sanitize-display-messages";
import type { DisplayMessage } from "@/domains/chat/types/types";

// ---------------------------------------------------------------------------
// Params & return type
// ---------------------------------------------------------------------------

export interface UseTranscriptDataParams {
  /** Whether the thinking indicator is active (from `useChatUIState`). */
  showThinking: boolean;
  /** Status label for the thinking indicator (from `useChatUIState`). */
  thinkingLabel: string | null;
  /** Whether the onboarding choice card should appear in the transcript. */
  showOnboardingChoice: boolean;
}

export interface TranscriptData {
  sanitizedMessages: DisplayMessage[];
  transcriptItems: TranscriptItem[];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTranscriptData({
  showThinking,
  thinkingLabel,
  showOnboardingChoice,
}: UseTranscriptDataParams): TranscriptData {
  // --- Store reads --------------------------------------------------------
  const messages = useChatSessionStore.use.messages();

  const pendingSecret = useInteractionStore.use.pendingSecret();
  const pendingConfirmation = useInteractionStore.use.pendingConfirmation();
  const pendingContactRequest = useInteractionStore.use.pendingContactRequest();

  const autoRoutedProfileLabel = useTurnStore.use.autoRoutedProfileLabel();

  // --- Sanitise -----------------------------------------------------------
  const sanitizedMessages = useMemo(
    () => sanitizeDisplayMessages(messages),
    [messages],
  );

  // --- Confirmation attachment check --------------------------------------
  // A confirmation that is already attached to an inline tool-call chip
  // should NOT also appear as a standalone transcript trailer row.
  const pendingConfirmationAttachedToToolCall = useMemo(
    () =>
      pendingConfirmation != null &&
      sanitizedMessages.some((m) =>
        m.toolCalls?.some(
          (tc) =>
            tc.pendingConfirmation?.requestId ===
            pendingConfirmation.requestId,
        ),
      ),
    [pendingConfirmation, sanitizedMessages],
  );

  // --- Build items --------------------------------------------------------
  const transcriptItems = useMemo(
    () =>
      buildTranscriptItems({
        messages: sanitizedMessages,
        pendingSecret: pendingSecret
          ? { requestId: pendingSecret.requestId }
          : null,
        pendingConfirmation:
          pendingConfirmation && !pendingConfirmationAttachedToToolCall
            ? { requestId: pendingConfirmation.requestId }
            : null,
        pendingContactRequest: pendingContactRequest
          ? {
              requestId: pendingContactRequest.requestId,
              channel: pendingContactRequest.channel,
              placeholder: pendingContactRequest.placeholder,
              label: pendingContactRequest.label,
              description: pendingContactRequest.description,
              role: pendingContactRequest.role,
            }
          : null,
        isThinking: showThinking,
        thinkingLabel,
        autoRoutedProfileLabel,
        showOnboardingChoice,
      }),
    [
      sanitizedMessages,
      pendingSecret,
      pendingConfirmation,
      pendingConfirmationAttachedToToolCall,
      pendingContactRequest,
      showThinking,
      thinkingLabel,
      autoRoutedProfileLabel,
      showOnboardingChoice,
    ],
  );

  return { sanitizedMessages, transcriptItems };
}
