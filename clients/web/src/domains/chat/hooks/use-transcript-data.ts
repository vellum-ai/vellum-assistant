/**
 * Transcript data derivation — sanitises messages and projects them into
 * the flat `TranscriptItem[]` list the virtualised transcript renders.
 *
 * Reads messages from `useChatSessionStore` and interaction prompts from
 * `useInteractionStore`. UI-level flags (`showThinking`, `thinkingLabel`) are
 * received as parameters from the caller's `useChatUIState` result to
 * avoid duplicating that hook's memoisation chain.
 *
 * @see buildTranscriptItems for the projection rules.
 * @see sanitizeDisplayMessages for the cleanup pipeline.
 */

import { useMemo } from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { buildTranscriptItems } from "@/domains/chat/transcript/build-items";
import { isSubagentSpawnCall } from "@/domains/chat/transcript/message-content";
import type { TranscriptItem } from "@/domains/chat/transcript/types";
import { sanitizeDisplayMessages } from "@/domains/chat/utils/sanitize-display-messages";
import type { DisplayMessage } from "@/domains/chat/types/types";

// ---------------------------------------------------------------------------
// Params & return type
// ---------------------------------------------------------------------------

export interface UseTranscriptDataParams {
  /** The rendered transcript — cached history ⊕ the in-flight turn, from
   *  `useTranscriptMessages`. The caller owns the union so it is computed once. */
  messages: DisplayMessage[];
  /** Whether the thinking indicator is active (from `useChatUIState`). */
  showThinking: boolean;
  /** Whether the assistant is busy on an in-flight turn (from
   *  `useChatUIState.isAssistantBusy`). Keeps the thinking slot mounted across
   *  the whole turn so the indicator fades instead of reflowing the list. */
  turnActive: boolean;
  /** Status label for the thinking indicator (from `useChatUIState`). */
  thinkingLabel: string | null;
  /** Whether the onboarding choice card should appear in the transcript. */
  showOnboardingChoice: boolean;
  /**
   * Whether the org's credit balance is exhausted (from the shared
   * `useBillingBalanceStatus()` read in `chat-route-content`). Drives the
   * projection's credits-upsell surfaces; see `BuildTranscriptItemsInput`.
   */
  creditsExhausted: boolean;
}

export interface TranscriptData {
  sanitizedMessages: DisplayMessage[];
  transcriptItems: TranscriptItem[];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTranscriptData({
  messages,
  showThinking,
  turnActive,
  thinkingLabel,
  showOnboardingChoice,
  creditsExhausted,
}: UseTranscriptDataParams): TranscriptData {
  // --- Store reads --------------------------------------------------------
  const ephemeralMetaResults = useChatSessionStore.use.ephemeralMetaResults();

  const pendingSecret = useInteractionStore.use.pendingSecret();
  const pendingConfirmation = useInteractionStore.use.pendingConfirmation();
  const pendingContactRequest = useInteractionStore.use.pendingContactRequest();

  // --- Sanitise -----------------------------------------------------------
  const sanitizedMessages = useMemo(
    () => sanitizeDisplayMessages(messages),
    [messages],
  );

  // --- Confirmation attachment check --------------------------------------
  // The trailer row is the home for a prompt no chip is showing, so the two
  // surfaces have to agree on one question: is this prompt on screen already?
  //
  // "Attached to a tool call" is not that question. A subagent spawn carries a
  // prompt like any other call but renders no chip (`renderableToolCalls` in
  // `transcript-message-body` filters it out in favour of the inline subagent
  // card), so counting it as shown suppresses the trailer too and the user is
  // asked to approve something with no visible prompt. Attachment is only
  // "shown" when the carrying call is one the transcript actually draws.
  //
  // The other half of that filter, card-backing, is deliberately not mirrored.
  // Every route into it turns true only once the call has run: a workflow or
  // ACP id arrives on the launch event or in the result, a background-task id
  // is parsed out of the result, and an answered question is answered. A
  // pending prompt gates execution, so the call carrying one has not run and
  // cannot be card-backed by any of the four. Mirroring it would also mean
  // threading three store subscriptions into this hook to answer that.
  //
  // If that ever stops holding, the failure mode is this trailer going quiet
  // again for the affected call, so a card-backing route that can precede
  // execution needs mirroring here as well.
  const pendingConfirmationAttachedToToolCall = useMemo(
    () =>
      pendingConfirmation != null &&
      sanitizedMessages.some((m) =>
        m.toolCalls?.some(
          (tc) =>
            tc.pendingConfirmation?.requestId ===
              pendingConfirmation.requestId && !isSubagentSpawnCall(tc),
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
              defaultValue: pendingContactRequest.defaultValue,
              label: pendingContactRequest.label,
              description: pendingContactRequest.description,
              role: pendingContactRequest.role,
            }
          : null,
        isThinking: showThinking,
        turnActive,
        thinkingLabel,
        ephemeralMetaResults,
        showOnboardingChoice,
        creditsExhausted,
      }),
    [
      creditsExhausted,
      sanitizedMessages,
      pendingSecret,
      pendingConfirmation,
      pendingConfirmationAttachedToToolCall,
      pendingContactRequest,
      showThinking,
      turnActive,
      thinkingLabel,
      ephemeralMetaResults,
      showOnboardingChoice,
    ],
  );

  return { sanitizedMessages, transcriptItems };
}
