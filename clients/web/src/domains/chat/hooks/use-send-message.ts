/**
 * Handles sending user messages, managing the stream lifecycle, and
 * queue operations (cancel, delete, edit).
 *
 * Orchestrates: optimistic message insertion, draft key resolution,
 * stream creation via `postChatMessage`, and processing-key tracking.
 * Reply delivery and turn settlement are owned by the SSE stream plus the
 * reconciliation loop — there is no client-side polling fallback.
 *
 * Composes `useMessageQueue` for queue management and imports pure
 * transforms from `send-message-utils`.
 */

import { t } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { type MutableRefObject, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "@vellumai/design-library/components/toast";
import { routes } from "@/utils/routes";
import { conversationsByIdSlashPost } from "@/generated/daemon/sdk.gen";
import {
  isLocalMetaCommand,
  parseDoctorCommand,
} from "@/domains/chat/components/chat-composer/slash-command-catalog";
import { useDoctorHandoffStore } from "@/stores/doctor-handoff-store";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { saveContextWindowUsage } from "@/domains/chat/utils/context-window-storage";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator";

import type {
  DisplayAttachment,
  DisplayMessage,
} from "@/domains/chat/types/types";
import { patchTranscriptMessages } from "@/domains/chat/transcript/patch-transcript-messages";
import { isAsyncChatScopeCurrent } from "@/domains/chat/utils/conversation-scope";
import { resolveEditChatDraftConversationId } from "@/utils/edit-chat-session";
import {
  type DiskPressureChatBlockReason,
  getDiskPressureChatBlockMessage,
} from "@/assistant/disk-pressure";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { recordDiagnostic } from "@/lib/diagnostics";
import { saveDismissedSurfaceIds } from "@/domains/chat/utils/dismissed-surfaces-storage";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import { endTurn } from "@/domains/chat/turn-coordinator";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useConversationStore } from "@/stores/conversation-store";
import {
  prependConversation,
  removeConversation,
  resolveDraftKey,
  shouldSurfaceConversation,
  surfaceConversationInCaches,
} from "@/utils/conversation-cache-mutations";
import {
  findConversation,
  patchConversation,
} from "@/utils/conversation-cache";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import {
  consumePendingPreChatContext,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat";

import { clearQueueStatus } from "@/domains/chat/utils/stream-updaters/shared";
import type { ChatError } from "@/domains/chat/types";

import {
  clearPendingConfirmationsFromMessages,
  dismissInteractiveSurfaces,
  newTurnId,
  resolvePostError,
  shouldCleanupSupersededInteractions,
} from "@/domains/chat/utils/send-message-utils";
import type { UIContext } from "@/domains/chat/turn-selectors";
import { useComposerStore } from "@/domains/chat/composer-store";
import { getSoundManager } from "@/lib/sounds/sound-manager";
import { useMessageQueue } from "@/domains/chat/hooks/use-message-queue";
import { confirmQueuedMessageDeletion } from "@/domains/chat/queue-cancellation";
import { conversationsByIdCancelPost } from "@/generated/daemon/sdk.gen";
import type { Conversation } from "@/types/conversation-types";
import { postChatMessage } from "@/domains/chat/api/messages";
import { surfaceConversation } from "@/domains/chat/api/conversations";
import { supportsServerMintedConversation } from "@/lib/backwards-compat/server-minted-conversation";
import { resolveSupportsNewChatPlugins } from "@/lib/backwards-compat/use-supports-new-chat-plugins";
import {
  ConversationNotFoundError,
  fetchConversationDetail,
} from "@/utils/fetch-conversation-detail";

// ---------------------------------------------------------------------------
// Stream send result
// ---------------------------------------------------------------------------

/**
 * Tagged result of `sendMessageViaStream`. Surfaced to the caller so it can
 * differentiate clean success, in-flight scope changes (ignore), and POST
 * failures (which require optimistic-state rollback).
 *
 * Previously the hook returned `string | undefined` and called `setError`
 * directly, which made it impossible for the caller to roll back the
 * optimistic user-message bubble or remove the just-prepended draft
 * conversation from the sidebar.
 */
type SendStreamResult =
  | {
      status: "ok";
      resolvedConversationId?: string;
      /** Server-assigned user message id from the active POST resolve.
       *  Absent for the queued path (POST returns only `requestId`) and
       *  for scope-changed-mid-flight results. The optimistic send is no
       *  longer id-swapped against this — the snapshot's echoed row and the
       *  overlay's `clientMessageId` dedup own that — so this is retained only
       *  for diagnostics / callers that want the persisted id. */
      userMessageId?: string;
    }
  | { status: "ignored" }
  | { status: "failed"; error: ChatError };

// ---------------------------------------------------------------------------
// Send options
// ---------------------------------------------------------------------------

/** Per-send options for `sendMessage`. */
export interface SendChatMessageOptions {
  /**
   * Persist the message but suppress it from the transcript (drives the
   * turn LLM-side). Used for machine signals the user never typed.
   */
  hidden?: boolean;
  /**
   * Single-use override for the daemon's `secret_blocked` ingress guard.
   * Set ONLY by the composer secret guard's "Send anyway" handler, after
   * the user explicitly confirmed sending content the client-side scan
   * blocked. Applies to this send alone and is never persisted.
   */
  bypassSecretCheck?: boolean;
  /**
   * True when this turn was auto-sent on the user's behalf rather than typed
   * the onboarding research prompt, the kickoff greeting, the legacy
   * pre-chat bootstrap. Forwarded to the daemon, which stamps it on the turn
   * so activation metrics can exclude it for every user rather than only
   * those whose diagnostics consent lets the trace classifier see it.
   *
   * Independent of `hidden`: the research prompt is visible AND scripted, the
   * kickoff greeting is hidden AND scripted. Omit for ordinary composer sends.
   */
  scripted?: boolean;
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

interface UseSendMessageParams {
  // Identity
  assistantId: string | null;
  activeConversationId: string | null;
  diskPressureChatBlockReason: DiskPressureChatBlockReason | null;
  uiContextRef: MutableRefObject<UIContext | null>;

  // Onboarding refs (ChatPage-local, not per-conversation)
  pendingOnboardingContextRef: MutableRefObject<PreChatOnboardingContext | null>;
  onboardingDraftConversationIdRef: MutableRefObject<string | null>;

  // Callbacks
  startReconciliationLoop: (epoch: number) => void;
  cancelReconciliation: () => void;
  refreshConversations: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSendMessage({
  assistantId,
  activeConversationId,
  diskPressureChatBlockReason,
  uiContextRef,
  pendingOnboardingContextRef,
  onboardingDraftConversationIdRef,
  startReconciliationLoop,
  cancelReconciliation,
  refreshConversations,
}: UseSendMessageParams) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The Doctor is platform-hosted only; when the active assistant is
  // self-hosted the Doctor tab doesn't exist, so `/doctor` must fall through
  // to a normal send rather than navigating to a doomed, empty tab.
  const doctorGate = usePlatformGate({ platformHostedOnly: true });
  const addOptimisticSend = useChatSessionStore.use.addOptimisticSend();
  const setOptimisticSends = useChatSessionStore.use.setOptimisticSends();
  const setError = useChatSessionStore.use.setError();
  const setNotice = useChatSessionStore.use.setNotice();

  // -------------------------------------------------------------------------
  // Server-mint in-flight gate
  // -------------------------------------------------------------------------
  // Holds the draft id of an in-flight server-mint POST (the FIRST
  // message in a brand-new conversation on an assistant that supports
  // `supportsServerMintedConversation()`). While set, `sendMessage`
  // refuses to start a new send — the POST 200s quickly so the window
  // is brief, and blocking is simpler than threading a deferred
  // through the queue path.
  //
  // Without this gate, a follow-up send during the window would post
  // the local draft key to a 0.8.6+ assistant's strict-lookup endpoint
  // and 404 (the assistant minted a different id).
  //
  // Cleared after the POST resolves or rejects. The draft-id check on
  // clear guards against re-mounts overwriting a newer mint.
  const pendingDraftMintRef = useRef<string | null>(null);
  const surfacingConversationIdsRef = useRef<Set<string>>(new Set());

  // -------------------------------------------------------------------------
  // Queue management (delegated to useMessageQueue)
  // -------------------------------------------------------------------------
  const {
    revertQueuedMessage,
    queuedMessages,
    handleCancelQueuedMessage,
    handleCancelAllQueued,
    handleSteerMessage,
    handleEditQueueTail,
  } = useMessageQueue({
    assistantId,
    activeConversationId,
  });

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  /**
   * Persist dismissed surface IDs to both the in-memory ref and local
   * storage. Extracted so optimistic-send updaters stay pure.
   */
  const persistDismissedSurfaces = useCallback((dismissedIds: Set<string>) => {
    useChatSessionStore.getState().addDismissedSurfaceIds(dismissedIds);
    const streamCtx = useStreamStore.getState().streamContext;
    if (streamCtx) {
      saveDismissedSurfaceIds(
        streamCtx.assistantId,
        streamCtx.conversationId,
        useChatSessionStore.getState().dismissedSurfaceIds,
      );
    }
  }, []);

  const surfaceConversationAfterUserSend = useCallback(
    async (conversationId: string) => {
      if (!assistantId) {
        return;
      }
      if (surfacingConversationIdsRef.current.has(conversationId)) {
        return;
      }

      let conversation = findConversation(
        queryClient,
        assistantId,
        conversationId,
      );
      if (!conversation) {
        try {
          conversation = await fetchConversationDetail(
            queryClient,
            assistantId,
            conversationId,
          );
        } catch (err) {
          if (err instanceof ConversationNotFoundError) {
            return;
          }
          throw err;
        }
      }

      if (!shouldSurfaceConversation(conversation)) {
        return;
      }

      surfacingConversationIdsRef.current.add(conversationId);
      try {
        const surfacedAt = await surfaceConversation(
          assistantId,
          conversationId,
        );
        surfaceConversationInCaches(
          queryClient,
          assistantId,
          conversation,
          surfacedAt,
        );
      } finally {
        surfacingConversationIdsRef.current.delete(conversationId);
      }
    },
    [assistantId, queryClient],
  );

  // -------------------------------------------------------------------------
  // sendMessageViaStream — low-level POST + polling fallback
  // -------------------------------------------------------------------------
  const sendMessageViaStream = useCallback(
    async (
      content: string,
      epoch: number,
      turnId: string,
      attachmentIds: string[] = [],
      isDraft = false,
      clientMessageId?: string,
      isHidden = false,
      bypassSecretCheck = false,
      // Tri-state, so the default is `undefined` (unknown), NOT false. This
      // helper has callers that genuinely cannot say, and inventing a `false`
      // here would assert "the user typed this" on their behalf. The daemon
      // applies its own default for an omitted field.
      scripted?: boolean,
    ): Promise<SendStreamResult> => {
      if (!activeConversationId || !assistantId) {
        return {
          status: "failed",
          error: { message: "No active conversation. Please try again." },
        };
      }
      const requestAssistantId = assistantId;
      const requestConversationId = activeConversationId;
      const isCurrentSendScope = (resolvedConversationId?: string | null) =>
        isAsyncChatScopeCurrent({
          currentAssistantId:
            useResolvedAssistantsStore.getState().activeAssistantId,
          currentConversationId:
            useConversationStore.getState().activeConversationId,
          requestAssistantId,
          requestConversationId,
          resolvedConversationId,
        });

      const onboardingContext =
        pendingOnboardingContextRef.current ?? consumePendingPreChatContext();
      if (onboardingContext && !pendingOnboardingContextRef.current) {
        pendingOnboardingContextRef.current = onboardingContext;
      }
      // Server-minted flow: when the conversation is a fresh client-side
      // draft AND the assistant supports server-side minting, send the
      // POST without any conversation id wire field. The assistant mints
      // a row and returns its id as `postResult.conversationId`; the
      // existing draft-key-resolution code path below swaps the
      // optimistic state and navigates the URL. Falling back to the
      // assistant-known `requestConversationId` for non-drafts or
      // pre-0.8.6 assistants preserves the legacy `conversationKey`
      // create-or-lookup behavior through `pickConversationIdWireField()`.
      const useServerMint = isDraft && supportsServerMintedConversation();
      // While this POST is in flight, `sendMessage` rejects new sends
      // for this draft — see `pendingDraftMintRef` declaration above.
      if (useServerMint) {
        pendingDraftMintRef.current = requestConversationId;
      }
      // A model profile the user picked in the composer before this
      // conversation's row was available — a brand-new draft, or an existing
      // conversation opened by URL while still loading (see
      // `ComposerSettingsMenu`). Forward it so this turn, and the conversation's
      // per-conversation override, use the chosen profile instead of the global
      // default — covering the window before the menu's load-time promotion PUT
      // lands. Keyed by id, so only this conversation's own stash is read.
      const inferenceProfileForSend = useConversationStore
        .getState()
        .pendingDraftProfiles.get(requestConversationId);
      // A per-chat plugin set the user picked in the composer before this
      // conversation's row existed — mirrors `inferenceProfileForSend`. Only an
      // EXPLICIT selection (an entry in the map, including an empty set) is
      // forwarded; an untouched default has no entry and sends `undefined`.
      // Gated on resolved daemon support — older daemons silently drop the
      // field, so the version must hydrate before deciding (see
      // `use-supports-new-chat-plugins`).
      const draftPlugins = useConversationStore
        .getState()
        .pendingDraftPlugins.get(requestConversationId);
      const enabledPluginsForSend =
        draftPlugins && (await resolveSupportsNewChatPlugins())
          ? [...draftPlugins].sort()
          : undefined;
      let postResult: Awaited<ReturnType<typeof postChatMessage>>;
      try {
        postResult = await postChatMessage(
          requestAssistantId,
          useServerMint ? null : requestConversationId,
          content,
          {
            attachmentIds,
            onboarding: onboardingContext ?? undefined,
            clientMessageId,
            inferenceProfile: inferenceProfileForSend,
            enabledPlugins: enabledPluginsForSend,
            hidden: isHidden,
            bypassSecretCheck,
            scripted,
          },
        );
      } finally {
        // Release the gate however the POST settles. A throw that skipped this
        // would leave it held for the rest of the session, rejecting every
        // later send for this draft with the "setting up your conversation"
        // message. Clear only if we still own it: a re-mount or scope flip
        // during the await could have already replaced it with a newer draft's
        // mint.
        if (
          useServerMint &&
          pendingDraftMintRef.current === requestConversationId
        ) {
          pendingDraftMintRef.current = null;
        }
      }
      if (!postResult.ok) {
        if (!isCurrentSendScope()) {
          recordDiagnostic("send_error_ignored_inactive_conversation", {
            assistantId: requestAssistantId,
            conversationId: requestConversationId,
            activeAssistantId:
              useResolvedAssistantsStore.getState().activeAssistantId,
            activeConversationId:
              useConversationStore.getState().activeConversationId,
          });
          // Ignored is about the UI, not about the message. Nothing on screen
          // belongs to this send any more, but its text was cleared from the
          // composer when it started and this failure is the end of the line
          // for it, so it goes back to its own conversation's draft rather than
          // nowhere. A hidden send has no user text to give back.
          if (!isHidden) {
            useComposerStore
              .getState()
              .restoreFailedDraft(
                requestAssistantId,
                requestConversationId,
                content,
              );
          }
          return { status: "ignored" };
        }
        const detail = resolvePostError(
          postResult.error.code,
          postResult.error.detail,
          "Something went wrong. Please try again.",
        );
        endTurn({ conversationId: requestConversationId, reason: "error" });
        return {
          status: "failed",
          error: {
            message: detail,
            ...(postResult.error.code ? { code: postResult.error.code } : {}),
          },
        };
      }
      // Success — drain the ref so subsequent messages omit the field.
      pendingOnboardingContextRef.current = null;
      // The draft's stashed profile (if any) has now been persisted on the
      // minted conversation; drop this draft's entry so it can't re-apply to a
      // later send. Cleared only on success — a failed draft send keeps the
      // stash so a retry still carries the chosen profile — and only while the
      // stash still holds the value that was sent: a newer selection made
      // mid-flight must survive so the mint-time re-key below can carry it to
      // the minted conversation.
      if (
        inferenceProfileForSend &&
        useConversationStore
          .getState()
          .pendingDraftProfiles.get(requestConversationId) ===
          inferenceProfileForSend
      ) {
        useConversationStore
          .getState()
          .clearPendingDraftProfile(requestConversationId);
      }
      // Same lifecycle as the profile stash: the draft's plugin selection has
      // now been persisted on the minted conversation, so drop this draft's
      // entry. Cleared only on success — a failed send keeps the stash so a
      // retry still carries the chosen plugins.
      if (draftPlugins) {
        useConversationStore
          .getState()
          .clearPendingDraftPlugins(requestConversationId);
      }
      if (onboardingDraftConversationIdRef.current === activeConversationId) {
        onboardingDraftConversationIdRef.current = null;
      }

      if (isCurrentSendScope()) {
        useTurnStore.getState().acceptSend(turnId);
      }

      // `postChatMessage`'s success contract guarantees a non-empty
      // `conversationId` — the server-mint path explicitly returns a
      // failure when the assistant accepts the message without echoing
      // a conversation id back, so by the time we get here it must be
      // a real id. The typecheck enforces this; the explicit
      // `effectiveConversationId` alias preserves the existing names
      // used downstream.
      const effectiveConversationId = postResult.conversationId;

      if (!isCurrentSendScope(effectiveConversationId)) {
        recordDiagnostic("send_result_ignored_inactive_conversation", {
          assistantId: postResult.assistantId,
          conversationId: requestConversationId,
          resolvedConversationId: effectiveConversationId,
          activeAssistantId:
            useResolvedAssistantsStore.getState().activeAssistantId,
          activeConversationId:
            useConversationStore.getState().activeConversationId,
        });
        return {
          status: "ok",
          resolvedConversationId: postResult.conversationId,
        };
      }

      void surfaceConversationAfterUserSend(effectiveConversationId).catch(
        (err) => {
          captureError(err, { context: "surface_conversation_after_send" });
        },
      );

      const streamState = useStreamStore.getState();
      const existingStreamContext = streamState.streamContext;
      const hasMatchingActiveStream =
        !!streamState.stream &&
        existingStreamContext?.assistantId === postResult.assistantId &&
        existingStreamContext.conversationId === effectiveConversationId;

      streamState.setStreamContext({
        assistantId: postResult.assistantId,
        conversationId: effectiveConversationId,
      });

      if (postResult.queued) {
        // The client believed the conversation was idle (so it took the
        // active-send path), but the assistant was still processing and
        // queued this message instead. Reflect the queued state on the
        // optimistic row so it renders with queued affordances rather than
        // as a normal in-flight send: tag it `queueStatus: "queued"`, track
        // it in the pending-queue FIFO so the `message_queued` SSE event can
        // assign its real position, and register the request id eagerly so
        // steer/cancel work before the event arrives. Mirrors the
        // willQueue path in `sendMessage`.
        if (clientMessageId) {
          useChatSessionStore
            .getState()
            .pushPendingQueuedMessageId(clientMessageId);
          setOptimisticSends((prev) =>
            prev.map((m) =>
              m.id === clientMessageId
                ? {
                    ...m,
                    queueStatus: "queued" as const,
                    queuePosition: m.queuePosition ?? 0,
                  }
                : m,
            ),
          );
          if (postResult.requestId) {
            useChatSessionStore
              .getState()
              .setRequestIdMapping(postResult.requestId, clientMessageId);
          }
        }
        return {
          status: "ok",
          resolvedConversationId: postResult.conversationId,
        };
      }
      if (hasMatchingActiveStream) {
        return {
          status: "ok",
          userMessageId: postResult.messageId,
          resolvedConversationId: postResult.conversationId,
        };
      }

      // No matching live stream: SSE delivers the reply and settles the turn;
      // startReconciliationLoop is the disconnect-safe backstop.
      startReconciliationLoop(epoch);
      return {
        status: "ok",
        userMessageId: postResult.messageId,
        resolvedConversationId: postResult.conversationId,
      };
    },
    [
      activeConversationId,
      assistantId,
      startReconciliationLoop,
      surfaceConversationAfterUserSend,
    ],
  );

  // -------------------------------------------------------------------------
  // runLocalMetaCommand — resolve a local meta slash command without a turn
  // -------------------------------------------------------------------------
  const runLocalMetaCommand = useCallback(
    async (
      command: string,
      conversationId: string,
      activeAssistantId: string,
    ) => {
      try {
        const { data, error } = await conversationsByIdSlashPost({
          path: { assistant_id: activeAssistantId, id: conversationId },
          body: { command: command.trim() },
          throwOnError: false,
        });
        if (error || !data) {
          toast.error(t("chat:useSendMessage.commandFailed"));
          return;
        }
        // The command ran against its own conversation and the daemon has
        // already answered for it, so nothing about it is cancelled here. What
        // is scoped is where the answer is drawn: the ephemeral card and the
        // context-usage readout describe the ONE thread on screen, and a
        // command whose thread the user left while the send chain held it
        // would otherwise render its card in whatever transcript is open.
        //
        // Read at answer time rather than at call time, since the round trip
        // is the window the switch happens in.
        const answerIsOnScreen = isAsyncChatScopeCurrent({
          currentAssistantId:
            useResolvedAssistantsStore.getState().activeAssistantId,
          currentConversationId:
            useConversationStore.getState().activeConversationId,
          requestAssistantId: activeAssistantId,
          requestConversationId: conversationId,
        });
        if (answerIsOnScreen) {
          useChatSessionStore.getState().addEphemeralMetaResult({
            id: crypto.randomUUID(),
            kind: data.kind,
            text: data.text,
          });
        }
        if (data.contextUsage) {
          const usage: ContextWindowUsage = {
            tokens: data.contextUsage.tokens,
            maxTokens: data.contextUsage.maxTokens,
            fillRatio: data.contextUsage.fillRatio,
          };
          // Both of these are keyed by conversation and stay correct wherever
          // the user is: the per-conversation map is what the indicator reads
          // on the way back into this thread, and the stored copy survives a
          // reload. Only the live readout describes the open thread.
          useChatSessionStore
            .getState()
            .setContextWindowUsageForConversation(conversationId, usage);
          saveContextWindowUsage(activeAssistantId, conversationId, usage);
          if (answerIsOnScreen) {
            useChatSessionStore.getState().setContextWindowUsage(usage);
          }
        }
      } catch (err) {
        captureError(err, { context: "run_local_meta_command" });
        toast.error(t("chat:useSendMessage.commandFailed"));
      }
    },
    [],
  );

  // -------------------------------------------------------------------------
  // sendMessage — high-level send with UI state, queuing, draft resolution
  // -------------------------------------------------------------------------
  const sendMessage = useCallback(
    async (
      content: string,
      attachments: DisplayAttachment[] = [],
      opts: SendChatMessageOptions = {},
    ) => {
      // A hidden send (e.g. the onboarding "Let's chat" kickoff) drives a turn
      // and the assistant's reply, but renders NO user bubble: skip the
      // optimistic row here and the daemon suppresses the echo. Hidden sends are
      // always a fresh first message (conversation idle), so they never take the
      // queue path below.
      const isHidden = opts.hidden === true;
      // Whether the transcript on screen is still the one this send belongs to.
      //
      // A send can be entered after an await that began under a different
      // conversation: the composer resolves a camera frame and reposts an
      // edited message before calling in here, and the user is free to switch
      // threads while either runs. The POST further down targets the conversation
      // this call closed over, so the message is delivered either way. What does
      // not travel with it is every store this function writes on the way: the
      // turn phase, the interaction surfaces, and the transcript itself all
      // describe the ONE conversation on screen, and a stale send writing into
      // them dresses somebody else's thread up as this one's.
      //
      // Nothing is deferred by skipping them, because there is no equivalent
      // work to do for the original conversation: `switchToConversation` resets
      // the turn and interaction stores and blanks the session snapshot on
      // every move, so reopening that thread re-derives its state from history
      // and the live stream. The sidebar's own processing key is written
      // against the conversation id further down and stays correct.
      //
      // Asked, never remembered. The user can switch at any point, the POST
      // being the longest such window, so a snapshot taken here would be
      // answering for a screen that has since changed. Every write reads it
      // where it stands; the pre-POST ones all run in one synchronous stretch,
      // so they see one another's answer regardless.
      //
      // Hoisted above the `/doctor` branch, which runs before this function's
      // own null guard, so the two ids are checked here rather than relied on
      // from a narrowing that a closure cannot carry. Every other caller runs
      // past that guard, where both are non-null and the extra checks stand
      // true.
      const sendScopeIsCurrent = () =>
        assistantId !== null &&
        activeConversationId !== null &&
        isAsyncChatScopeCurrent({
          currentAssistantId:
            useResolvedAssistantsStore.getState().activeAssistantId,
          currentConversationId:
            useConversationStore.getState().activeConversationId,
          requestAssistantId: assistantId,
          requestConversationId: activeConversationId,
        });

      // `/doctor <message>` navigates to the Doctor panel rather than starting
      // an assistant turn, parking the first message in a hand-off store so the
      // panel can auto-start a session and send it. Handled before the
      // conversation/disk-pressure guards below since it needs neither.
      const doctorPrompt = parseDoctorCommand(content);
      if (doctorPrompt !== null) {
        // Dropped outright when its thread is no longer the one on screen.
        // The composer serializes deliveries, so a `/doctor` typed behind a
        // pending camera frame arrives whenever that frame resolves, and
        // navigating then would take the window the user is now working in to
        // a panel they did not ask for. A navigation intent from a context the
        // user has abandoned is not deferred, it is dropped: nothing is parked
        // either, since a hand-off prompt with no navigation behind it would
        // surface unbidden on their next visit to the Doctor.
        //
        // Ahead of both branches, so neither half of the command can run
        // without the other. A send that had no conversation of its own has no
        // thread to have left, and keeps today's behavior.
        if (activeConversationId !== null && !sendScopeIsCurrent()) {
          return;
        }
        // The Doctor is platform-hosted only. On a self-hosted assistant its
        // tab doesn't exist, so the command is disabled: clear the input and
        // surface a notice rather than sending "/doctor …" as a normal turn.
        if (doctorGate === "gated") {
          useComposerStore.getState().setInput("");
          toast.info(t("chat:useSendMessage.doctorUnavailable"));
          return;
        }
        if (doctorPrompt) {
          useDoctorHandoffStore.getState().setPendingPrompt(doctorPrompt);
        }
        useComposerStore.getState().setInput("");
        navigate(`${routes.settings.debug}?tab=doctor`);
        return;
      }
      // Explicit user override from the composer secret guard's "Send
      // anyway" confirmation — forwarded on this send's POST only.
      const bypassSecretCheck = opts.bypassSecretCheck === true;
      if (!activeConversationId || !assistantId) {
        setError({ message: "No active conversation. Please try again." });
        return;
      }
      // Block any send while a server-mint POST is in flight for the
      // active draft. The POST 200s quickly so this window is brief;
      // rejecting is simpler than threading the unresolved id through
      // the queue path. See `pendingDraftMintRef` declaration.
      if (pendingDraftMintRef.current === activeConversationId) {
        setError({
          message:
            "Setting up your conversation. Please try again in a moment.",
        });
        return;
      }
      if (diskPressureChatBlockReason) {
        setError({
          message: getDiskPressureChatBlockMessage(diskPressureChatBlockReason),
        });
        return;
      }
      if (sendScopeIsCurrent()) {
        setError(null);
        setNotice(null);
      }
      // Local meta commands (/clean, /status, /commands, /models) never start a
      // turn: resolve them via the daemon and render an ephemeral card.
      if (isLocalMetaCommand(content)) {
        await runLocalMetaCommand(content, activeConversationId, assistantId);
        return;
      }
      // A real send supersedes any ephemeral meta-command cards. Only the ones
      // on screen: see `sendScopeIsCurrent`. Hidden sends supersede them too, as
      // they always have, since the surfaces belong to the thread rather than
      // to the row a send does or does not draw.
      if (sendScopeIsCurrent()) {
        useChatSessionStore.getState().clearEphemeralMetaResults();
        useInteractionStore.getState().resetSecretAndConfirmation();
      }
      // NOTE: a send deliberately does NOT dismiss the "Connect Claude Code"
      // prompt. Unlike a turn-blocking confirmation/secret (superseded by the
      // next send), the Connect card is a non-blocking remediation CTA that
      // stays until the user resolves it — connects (self-heal / auto-continue)
      // or dismisses it (X) — the way `ask_question` stays until answered. The
      // post-connect retirement lives in `useAcpAutoContinue` instead.
      if (sendScopeIsCurrent()) {
        useChatSessionStore.getState().clearConfirmationToolCallMap();
      }
      // Clear pending confirmations and dismiss interactive surfaces in a
      // single functional updater so the two transforms compose correctly
      // within React 18's batched state updates. Side effects (ref mutation,
      // localStorage persist) are kept outside the updater to stay pure.
      // Scan the full rendered transcript — the materialized snapshot, which
      // holds both persisted history and the just-streamed turn — for
      // superseded interactive surfaces and pending confirmations, so a
      // resubmit can't act on a request the daemon already resolved. The
      // clear + dismiss transform is applied via patchTranscriptMessages (a
      // no-op for rows it doesn't match) to both the snapshot and the history
      // cache, and the dismissed-id list that drives the hide set is computed
      // over the same view.
      if (
        sendScopeIsCurrent() &&
        shouldCleanupSupersededInteractions(uiContextRef.current)
      ) {
        const transcriptForScan =
          useChatSessionStore.getState().snapshot?.messages ?? [];

        patchTranscriptMessages((prev) => {
          const cleared = clearPendingConfirmationsFromMessages(prev);
          const { updatedMessages, dismissedIds } = dismissInteractiveSurfaces(
            cleared,
            transcriptForScan,
          );
          return dismissedIds.size > 0 ? updatedMessages : cleared;
        });

        // Persist dismissed surfaces outside the updater (side effect).
        const { dismissedIds } = dismissInteractiveSurfaces(
          transcriptForScan,
          transcriptForScan,
        );
        if (dismissedIds.size > 0) {
          persistDismissedSurfaces(dismissedIds);
          useTurnStore.getState().dismissSurface();
        }
      }

      const willQueue = isSending(useTurnStore.getState().phase);
      const clientMessageId = crypto.randomUUID();
      const userMessage: DisplayMessage = {
        id: clientMessageId,
        clientMessageId,
        isOptimistic: true,
        role: "user",
        textSegments: [content],
        contentOrder: [{ type: "text", id: "0" }],
        contentBlocks:
          content.trim().length > 0 ? [{ type: "text", text: content }] : [],
        timestamp: Date.now(),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(willQueue
          ? { queueStatus: "queued" as const, queuePosition: 0 }
          : {}),
      };
      // The row is skipped rather than added and removed: nothing would take it
      // back out, since a switch clears the list and this one arrives after
      // that. The server echo puts the message where it belongs when its thread
      // is next opened. The pending queue FIFO below follows the same rule.
      const rendersOptimisticRow = !isHidden && sendScopeIsCurrent();
      if (rendersOptimisticRow) {
        addOptimisticSend(userMessage);
      }
      void getSoundManager().play("message_sent");

      // Queue path: POST to assistant (it queues internally) but don't
      // disrupt the active turn.
      if (willQueue) {
        // A hidden send renders no optimistic row and the daemon suppresses
        // its queued ack, so there is nothing for the pending FIFO to bind.
        // Tracking it would park a dead entry at the head that the next
        // visible send's ack would bind to instead of its own row. A send
        // whose conversation is no longer on screen has no row here either,
        // and its ack belongs to a thread this FIFO does not describe.
        if (rendersOptimisticRow) {
          useChatSessionStore
            .getState()
            .pushPendingQueuedMessageId(userMessage.id);
        }
        const attachmentIds = attachments.map((att) => att.id);
        try {
          const postResult = await postChatMessage(
            assistantId,
            activeConversationId,
            content,
            {
              attachmentIds,
              clientMessageId,
              hidden: isHidden,
              bypassSecretCheck,
              scripted: opts.scripted,
            },
          );
          if (!postResult.ok) {
            // Reported only to the thread it happened in. The streaming path
            // answers a scope mismatch the same way, returning `ignored`
            // without surfacing anything, because an error banner raised over
            // a conversation the user is now reading describes a send they
            // cannot see and cannot retry from there.
            //
            // Asked here rather than remembered from before the POST: the
            // switch that moves this send off screen is at its most likely
            // during that round trip.
            const onScreenAtFailure = sendScopeIsCurrent();
            if (onScreenAtFailure) {
              revertQueuedMessage(userMessage.id);
              const detail = resolvePostError(
                postResult.error.code,
                postResult.error.detail,
                "Failed to queue message. Please try again.",
              );
              setError({
                message: detail,
                code: postResult.error.code ?? undefined,
              });
            }
            // Off screen there is no banner to carry the failure and no
            // composer of this thread's to put the text back into, so it goes
            // to that thread's draft instead of being lost. Its own condition
            // rather than the banner's `else`, because what matters is where
            // the send stands NOW: one that was on screen when it started and
            // is not by the time it fails belongs here.
            if (!onScreenAtFailure && !isHidden) {
              useComposerStore
                .getState()
                .restoreFailedDraft(assistantId, activeConversationId, content);
            }
            return;
          }
          void surfaceConversationAfterUserSend(
            postResult.conversationId,
          ).catch((err) => {
            captureError(err, {
              context: "surface_queued_conversation_after_send",
            });
          });
          if (!postResult.queued) {
            // The daemon processed the message directly (turn finished
            // between the client-side isSending check and the POST
            // arriving). Clear the optimistic queue status and let the
            // existing SSE stream deliver the response.
            //
            // All of that describes the thread on screen: the queue FIFO, the
            // row's queue badge, and the turn this send is now driving. A send
            // whose thread the user has left owns none of them, and claiming
            // the turn store here would replace the open conversation's phase
            // and active turn id, mid-answer if that thread is streaming. The
            // branch is reachable for such a send because `willQueue` reads
            // the open thread's phase, so it can queue a message for a
            // conversation that was idle all along. See `sendScopeIsCurrent`,
            // asked again here because the POST is a window the user can
            // switch threads inside.
            if (sendScopeIsCurrent()) {
              const queueIds =
                useChatSessionStore.getState().pendingQueuedMessageIds;
              const idx = queueIds.indexOf(userMessage.id);
              if (idx !== -1) {
                queueIds.splice(idx, 1);
              }
              setOptimisticSends((prev) =>
                clearQueueStatus(prev, userMessage.id),
              );
              const fallbackTurnId = newTurnId();
              useTurnStore.getState().requestSend(fallbackTurnId);
              useTurnStore.getState().acceptSend(fallbackTurnId);
            }
            // Keyed by conversation rather than by what is on screen, so it
            // stays correct for the thread this send belongs to either way.
            {
              const currentConv = findConversation(
                queryClient,
                assistantId,
                activeConversationId,
              );
              useConversationStore
                .getState()
                .addProcessingConversationId(
                  activeConversationId,
                  currentConv?.latestAssistantMessageAt,
                );
            }
            return;
          }
          const requestId = postResult.requestId;
          // The mapping exists to bind the daemon's `message_queued_deleted`
          // broadcast to a rendered row, and the deletion it would confirm can
          // only have been asked for from one. A send with no row on screen has
          // neither, so the whole block belongs to the thread on screen.
          if (requestId && sendScopeIsCurrent()) {
            const sessionStore = useChatSessionStore.getState();
            sessionStore.setRequestIdMapping(requestId, userMessage.id);
            if (sessionStore.consumePendingLocalDeletion(userMessage.id)) {
              await confirmQueuedMessageDeletion({
                assistantId,
                conversationId: activeConversationId,
                requestId,
                messageId: userMessage.id,
                setOptimisticSends,
                // Mapping cleanup only. `pendingQueuedCount` moves on the
                // daemon's `message_queued_deleted` broadcast, which lands on
                // this tab too, so decrementing here would double-count.
                onDeleted: () => {
                  useChatSessionStore.getState().popRequestIdMapping(requestId);
                },
              });
            }
          }
        } catch (err) {
          // Captured whatever the scope, since a thrown send is a real fault;
          // only its report to the user is scoped, as above.
          captureError(err, { context: "send_message_queue" });
          const onScreenAtThrow = sendScopeIsCurrent();
          if (onScreenAtThrow) {
            revertQueuedMessage(userMessage.id);
            setError({ message: "Failed to queue message. Please try again." });
          }
          if (!onScreenAtThrow && !isHidden) {
            useComposerStore
              .getState()
              .restoreFailedDraft(assistantId, activeConversationId, content);
          }
        }
        return;
      }

      const turnId = newTurnId();
      // The turn store describes the conversation on screen and nothing else,
      // so a send that is no longer on it must not put that thread into the
      // submitting phase: `acceptSend` below is already scope-checked and would
      // never arrive to clear it, leaving a composer disabled with no turn
      // behind it. The id still travels, so the send's own bookkeeping is
      // unchanged.
      if (sendScopeIsCurrent()) {
        useTurnStore.getState().requestSend(turnId);
      }

      const currentConv = findConversation(
        queryClient,
        assistantId,
        activeConversationId,
      );
      useConversationStore
        .getState()
        .addProcessingConversationId(
          activeConversationId,
          currentConv?.latestAssistantMessageAt,
        );

      // Optimistically add a stub conversation to the sidebar for draft
      // conversations that don't exist on the server yet.
      if (!currentConv) {
        prependConversation(queryClient, assistantId, {
          conversationId: activeConversationId,
          lastMessageAt: Date.now(),
          draft: true,
        } as Conversation);
      }

      // "A turn is starting here, so the stream takes over from the poll."
      // Below the events-tail floor that timer is the open thread's only
      // delivery backstop (at or above it the call is already a no-op, see
      // `useMessageReconciliation`), and a send that is no longer on screen is
      // starting a turn somewhere else. Cancelling would strand the thread the
      // user IS watching, and nothing re-arms it: such a send returns on its
      // own scope check inside `sendMessageViaStream` before that function
      // reaches `startReconciliationLoop`.
      //
      // Skipping arms nothing of its own. The loop's start is the only thing
      // that sets a timer and it replaces rather than stacks, so what is left
      // running is the open thread's own loop, reconciling the open thread.
      if (sendScopeIsCurrent()) {
        cancelReconciliation();
      }

      const isDraft = !currentConv;
      let resolvedId: string | undefined;

      try {
        const result = await sendMessageViaStream(
          content,
          useStreamStore.getState().streamEpoch,
          turnId,
          attachments.map((att) => att.id),
          isDraft,
          clientMessageId,
          isHidden,
          bypassSecretCheck,
          opts.scripted,
        );

        if (result.status === "failed") {
          // Roll back every piece of optimistic state we just set up: the
          // optimistic send, the processing flag on the conversation, the
          // prepended draft conversation in the sidebar, and the cleared
          // composer input. Then surface the error.
          setOptimisticSends((prev) =>
            prev.filter((m) => m.id !== userMessage.id),
          );
          useConversationStore
            .getState()
            .removeProcessingConversationId(activeConversationId);
          if (isDraft) {
            removeConversation(queryClient, assistantId, activeConversationId);
            setError({
              message: result.error.message,
              ...(result.error.code ? { code: result.error.code } : {}),
              displayAs: "modal",
              restoreContent: content,
            });
          } else {
            useComposerStore.getState().setInput(content);
            setError(result.error);
          }
          return;
        }

        if (result.status === "ignored") {
          // Scope changed mid-flight; the new scope owns UI state from here.
          return;
        }

        resolvedId = result.resolvedConversationId;

        // The send materialized the conversation, so the key is no longer a
        // draft: history is real from here and must show the normal loading
        // state when the user navigates back to it. Clears whether or not the
        // server kept the client key. When it assigned a different one, the
        // old key is dead and this is just cleanup.
        useConversationStore
          .getState()
          .clearDraftConversationId(activeConversationId);

        // Resolve draft key -> server-assigned conversation ID.
        if (resolvedId && resolvedId !== activeConversationId) {
          const newConversationId = resolvedId;
          useConversationStore
            .getState()
            .transferProcessingConversationId(
              activeConversationId,
              newConversationId,
            );
          resolveDraftKey(
            queryClient,
            assistantId,
            activeConversationId,
            newConversationId,
          );
          resolveEditChatDraftConversationId(
            activeConversationId,
            newConversationId,
          );
          // The companion surface's composer follows the same way, and for
          // the same reason: it holds a conversation of its own, so an id
          // re-keyed here and not there is an id that sends the surface's next
          // message into a thread that does not exist.
          useConversationStore
            .getState()
            .resolveCompanionDraftConversationId(
              activeConversationId,
              newConversationId,
            );

          // A profile picked while the mint was in flight is stashed under the
          // draft id after the POST already read the stash — re-key it to the
          // minted id so the composer's promotion effect persists it now that
          // the real row exists (ATL-1136).
          const stashedProfile = useConversationStore
            .getState()
            .pendingDraftProfiles.get(activeConversationId);
          if (stashedProfile !== undefined) {
            useConversationStore
              .getState()
              .setPendingDraftProfile(newConversationId, stashedProfile);
            useConversationStore
              .getState()
              .clearPendingDraftProfile(activeConversationId);
          }

          // Only update active view state if the user is still on this conversation.
          if (
            useConversationStore.getState().activeConversationId ===
            activeConversationId
          ) {
            useChatSessionStore.getState().markDraftResolution();
            useChatSessionStore.setState({
              previousConversationId: newConversationId,
            });
            useConversationStore
              .getState()
              .setActiveConversationId(newConversationId);
            void navigate(routes.conversation(newConversationId), {
              replace: true,
            });
          }
        } else if (resolvedId && isDraft) {
          // Legacy (pre-0.8.6) assistants echo the client-minted draft id
          // back, so the re-key above is skipped. The row is persisted
          // server-side now — a profile picked while the POST was in flight
          // still sits in the stash, and nothing would push it: the row's
          // draft flag only clears via the async list refetch, which doesn't
          // touch the promotion effect's deps. Clear the flag, then clear and
          // re-set the stash entry — `setPendingDraftProfile` no-ops on an
          // unchanged value, so a clear/set pair is needed to change the Map
          // identity the promotion effect depends on. Whether or not React
          // batches the pair into one render, the effect re-runs with the
          // stash present and persists the selection (ATL-1136).
          const stashedProfile = useConversationStore
            .getState()
            .pendingDraftProfiles.get(activeConversationId);
          if (stashedProfile !== undefined) {
            resolveDraftKey(queryClient, assistantId, activeConversationId, activeConversationId);
            useConversationStore
              .getState()
              .clearPendingDraftProfile(activeConversationId);
            useConversationStore
              .getState()
              .setPendingDraftProfile(activeConversationId, stashedProfile);
          }
        }

        void refreshConversations();
      } catch (err) {
        captureError(err, { context: "send_chat_message" });
        // The same split the queue branch's catch makes: the fault is recorded
        // whatever the scope, its report is not. `onStreamError` idles the turn
        // store and drops its active turn, which belongs to whichever thread is
        // on screen, so a stale send reaching it would end the answer the user
        // is actually watching.
        //
        // A throw is also the one failure that never reaches
        // `sendMessageViaStream`'s own scope classification, so this is the
        // only place that can hand the text back to its conversation.
        const onScreenAtThrow = sendScopeIsCurrent();
        if (onScreenAtThrow) {
          setError({ message: "Something went wrong. Please try again." });
          useTurnStore.getState().onStreamError();
        }
        if (!onScreenAtThrow && !isHidden) {
          useComposerStore
            .getState()
            .restoreFailedDraft(assistantId, activeConversationId, content);
        }
        // Multi-key processing-key cleanup: when a send is retargeted
        // (e.g. draft → new conversation), both the original active key
        // and the resolved key may have processing markers. `endTurn`
        // covers the single-conversation pairing; this catch-all clears
        // every key the send touched. Keyed by conversation, so it runs
        // wherever the user is standing.
        const keysToClean = [activeConversationId, resolvedId].filter(
          Boolean,
        ) as string[];
        if (keysToClean.length > 0) {
          useConversationStore
            .getState()
            .removeMultipleProcessingConversationIds(keysToClean);
        }
        if (isDraft) {
          removeConversation(queryClient, assistantId, activeConversationId);
        }
      }
    },
    [
      activeConversationId,
      assistantId,
      doctorGate,
      navigate,
      diskPressureChatBlockReason,
      uiContextRef,
      runLocalMetaCommand,
      sendMessageViaStream,
      refreshConversations,
      revertQueuedMessage,
      persistDismissedSurfaces,
      queryClient,
      surfaceConversationAfterUserSend,
    ],
  );

  // -------------------------------------------------------------------------
  // handleStopGenerating — cancel the active generation
  // -------------------------------------------------------------------------
  const handleStopGenerating = useCallback(async () => {
    if (!assistantId || !activeConversationId) {
      return;
    }
    useStreamStore.getState().bumpEpoch();
    patchConversation(queryClient, assistantId, activeConversationId, {
      isProcessing: false,
    });
    endTurn({ conversationId: activeConversationId, reason: "cancelled" });
    // Per-row clear (no-op for non-matching rows) → snapshot + history cache.
    patchTranscriptMessages(clearPendingConfirmationsFromMessages);
    useInteractionStore.getState().resetAll();
    useSubagentStore.getState().reset();
    useWorkflowStore.getState().reset();
    useChatSessionStore.getState().clearConfirmationToolCallMap();
    try {
      await conversationsByIdCancelPost({
        path: { assistant_id: assistantId, id: activeConversationId },
        throwOnError: true,
      });
    } catch {
      // Best-effort — the daemon may have already finished
    }
  }, [assistantId, activeConversationId, queryClient]);

  return {
    sendMessage,
    handleStopGenerating,
    queuedMessages,
    handleCancelQueuedMessage,
    handleCancelAllQueued,
    handleSteerMessage,
    handleEditQueueTail,
  };
}
