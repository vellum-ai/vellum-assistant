/**
 * Zustand store for interaction-prompt state (secret, confirmation,
 * contact-request, question).
 *
 * Manages four independent prompt lifecycles — each can be pending,
 * submitting, or idle simultaneously. Uses direct named actions per
 * Zustand's recommended pattern.
 *
 * @see https://zustand.docs.pmnd.rs/guides/flux-inspired-practice
 * @see https://zustand.docs.pmnd.rs/guides/updating-state
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

import type { PromptKind } from "@/domains/chat/prompt-submission";

import type {
  PendingSecretState,
  PendingConfirmationState,
  PendingContactRequestState,
  PendingQuestionState,
  PendingAcpConnectState,
} from "@/types/interaction-ui-types";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface InteractionState {
  /**
   * The request whose submission is in flight for each kind, or `null` when
   * none is.
   *
   * Carries the id rather than a bare flag because the answer a resume needs
   * after its await is "is this still *my* submission", and a boolean has
   * forgotten. Claimed by the submission that starts it and released by that
   * same submission, so the prompt's own lifecycle never touches it: a card
   * being raised, retired, or superseded says nothing about whether a request
   * is still on the wire. The daemon broadcasts `interaction_resolved` before
   * its POST response returns, so the matching resolution routinely retires a
   * card while its submission is still awaiting, and that submission must still
   * finish its own cleanup.
   *
   * Keyed rather than one field per kind because every kind wants exactly this
   * and they drifted apart when they were separate: questions grew a revision,
   * confirmations a scrub, secrets and contact requests neither.
   */
  submittingByKind: Record<PromptKind, string | null>;
  pendingSecret: PendingSecretState | null;
  secretSaved: boolean;

  pendingConfirmation: PendingConfirmationState | null;

  pendingContactRequest: PendingContactRequestState | null;
  contactRequestAccepted: boolean;

  pendingQuestion: PendingQuestionState | null;
  /**
   * Bumped on every change to {@link pendingQuestion}, so a reader that has to
   * leave and come back can tell whether the slot moved while it was away.
   * Comparing the value cannot answer that: a prompt that arrives and settles
   * inside one await returns the slot to `null`, which is indistinguishable
   * from never having changed, and a reconcile that trusted the comparison
   * would raise the settled prompt back onto the screen. Monotonic, never
   * reset, and meaningless in absolute terms; only differences matter.
   */
  questionRevision: number;
  /** When true, the question card is hidden but `pendingQuestion` stays set
   *  so the composer free-text intercept still routes to `submitQuestionResponse`. */
  isQuestionCardDismissed: boolean;

  inlineConfirmationToolCallId: string | null;

  /**
   * A missing-token `acp_spawn` failure raised an inline "Connect Claude Code"
   * prompt, anchored to the failed tool call. Unlike the other prompts this is
   * NOT a turn-blocking interaction — the turn already ended in error; it is a
   * remediation CTA. It is restored on a `/messages` reseed from the failed
   * tool call's persisted `errorCode` marker, so a reload or reconnect does
   * not lose it. To avoid nagging from history, a dismissal (the connect
   * flow's auto-continue, or the already-connected self-heal) is recorded in
   * `dismissedAcpConnectToolUseIds` and suppresses any later restore of that
   * same failed spawn.
   */
  pendingAcpConnect: PendingAcpConnectState | null;

  /**
   * Failed-`acp_spawn` tool-call ids whose Connect prompt was already retired
   * this session (by the connect flow's auto-continue or by the
   * already-connected self-heal). The
   * `errorCode` marker lives permanently in history, so without this a reseed
   * would re-raise the card on every turn until Claude is connected; recording
   * the id lets `showAcpConnect` no-op a restore of a retired prompt. A
   * genuine new failure gets a fresh tool-use id, so it is never suppressed.
   * Cleared with the rest of the store on conversation switch (`resetAll`).
   */
  dismissedAcpConnectToolUseIds: Set<string>;

  /**
   * One-shot trigger set when the inline Connect card finishes connecting, so
   * the assistant auto-continues the failed task without the user typing
   * "retry". The card can't reach `sendMessage` (it needs top-level context), so
   * it flips this flag and the chat view (which owns `sendMessage`) fires a
   * hidden continuation send, then clears it. Non-blocking; not part of
   * `hasActiveInteraction`.
   */
  pendingAcpContinue: boolean;

  /**
   * Whether this tab is currently running the Connect flow.
   *
   * A token write publishes an `acp:auth-recovery` invalidation that reaches
   * every client including the writer, and the daemon cannot tag the origin:
   * the retirement fires from the credential-write seam, which has no request
   * context to carry a client id. Acting on that echo here would dismiss the
   * card mid-flow, before it reaches `connected` and asks for the
   * auto-continue, so the tab running the flow ignores its own echo and lets
   * the flow finish clearing the card.
   */
  acpConnectFlowActive: boolean;
  /**
   * Where the Connect card is currently rendered, with the anchor it was
   * decided for.
   *
   * Held here rather than in either component that asks, so the transcript and
   * the composer cannot disagree about it, and so an in-progress OAuth flow can
   * pin the card in place: moving it between those two trees unmounts the
   * affordance that owns the flow.
   */
  acpConnectPlacement: {
    toolUseId: string;
    placement: "inline" | "docked" | null;
  } | null;

  /**
   * Bumped every time a Connect prompt is raised.
   *
   * An ACP snapshot fetch that was issued before a live `acp_auth_required`
   * event can land after it, and its unmarked rows would then retire a prompt
   * the daemon raised in the meantime. Because dismissal records the tool-use
   * id, that would also stop any later snapshot from restoring the card.
   * Callers capture this when they issue a fetch and only retire if it is
   * still current when the response is applied.
   */
  acpConnectRevision: number;

  /** Tool call IDs whose risk level was "unknown" when the user approved
   *  them — triggers the "command not recognized" nudge below their chip. */
  unknownNudgeToolCallIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface InteractionActions {
  /**
   * Record the outcome of a secret submission, which drives the card's saved
   * tick. Every submission that ends reports one, so a failed retry clears a
   * tick an earlier success left behind — but only on its own card, since the
   * tick belongs to the prompt on screen and a superseded request no longer
   * owns that.
   */
  setSecretSavedIfMatches: (requestId: string, saved: boolean) => void;
  /** Claim the submission slot for `kind`. */
  claimSubmission: (kind: PromptKind, requestId: string) => void;
  /** Release it, but only for the request that holds it. */
  releaseSubmission: (kind: PromptKind, requestId: string) => void;
  // Secret
  showSecret: (payload: PendingSecretState) => void;
  dismissSecretIfMatches: (requestId: string) => void;
  updateSecret: (requestId: string, patch: Partial<PendingSecretState>) => void;

  // Confirmation
  showConfirmation: (payload: PendingConfirmationState) => void;
  dismissConfirmationIfMatches: (requestId: string) => void;
  updateConfirmation: (
    requestId: string,
    patch: Partial<PendingConfirmationState>,
  ) => void;
  setInlineConfirmationToolCallId: (toolCallId: string | null) => void;
  /**
   * Unpin the inline card, but only when `toolCallId` is the anchor currently
   * held. A decision, a stale-prompt retire, and a resolved broadcast all end
   * one confirmation, and each must leave a different chip's card pinned.
   */
  releaseInlineAnchorIfMatches: (toolCallId: string | undefined) => void;

  // Contact request
  showContactRequest: (payload: PendingContactRequestState) => void;
  dismissContactRequestIfMatches: (requestId: string) => void;
  acceptContactRequest: () => void;

  // Question
  showQuestion: (payload: PendingQuestionState) => void;
  dismissQuestionIfMatches: (requestId: string) => void;
  dismissQuestionCard: () => void;

  // ACP Connect Claude prompt
  /**
   * Raise the Connect card.
   *
   * `supersedesDismissal` is for a failure happening now rather than one being
   * restored. The dismissed set is keyed by the spawning tool call, and a
   * resumed run reuses its original one, so a second rejection under the same
   * anchor looks identical to the card the user already dismissed. Ignoring it
   * would leave a live failure with no card, while the daemon goes on
   * redirecting credential prompts at one.
   */
  showAcpConnect: (
    payload: PendingAcpConnectState,
    opts?: { supersedesDismissal?: boolean },
  ) => void;
  /**
   * Give the standing Connect prompt the conversation that owns it, when it
   * was raised without one.
   *
   * `acp_auth_required` is global and carries no conversation, so a client
   * that missed the run's spawn event has nothing to attribute the prompt to.
   * An unowned prompt renders only inline under its anchor row, so it is
   * unreachable once that row is outside the loaded transcript.
   *
   * Matched on the tool-use id by the caller, so this identifies the prompt
   * already on screen rather than replacing it. Deliberately does not advance
   * `acpConnectRevision`: nothing was raised or retired, the same prompt is
   * merely better identified, and advancing it would invalidate reads that are
   * legitimately in flight.
   */
  adoptAcpConnectConversation: (conversationId: string) => void;
  dismissAcpConnect: () => void;
  requestAcpContinue: () => void;
  setAcpConnectFlowActive: (active: boolean) => void;
  setAcpConnectPlacement: (
    placement: {
      toolUseId: string;
      placement: "inline" | "docked" | null;
    } | null,
  ) => void;
  clearAcpContinue: () => void;

  // Nudge tracking
  addUnknownNudgeToolCallId: (toolCallId: string) => void;
  removeUnknownNudgeToolCallId: (toolCallId: string) => void;

  // Resets
  resetSecretAndConfirmation: () => void;
  resetAll: () => void;
}

export type InteractionStore = InteractionState & InteractionActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: InteractionState = {
  submittingByKind: {
    confirmation: null,
    question: null,
    secret: null,
    contactRequest: null,
  },
  pendingSecret: null,
  secretSaved: false,

  pendingConfirmation: null,

  pendingContactRequest: null,
  contactRequestAccepted: false,

  pendingQuestion: null,
  questionRevision: 0,
  isQuestionCardDismissed: false,

  inlineConfirmationToolCallId: null,

  pendingAcpConnect: null,
  dismissedAcpConnectToolUseIds: new Set<string>(),
  acpConnectFlowActive: false,
  acpConnectPlacement: null,
  acpConnectRevision: 0,
  pendingAcpContinue: false,

  unknownNudgeToolCallIds: new Set<string>(),
};

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** True when any interactive prompt is visible to the user. */
export function hasActiveInteraction(state: InteractionState): boolean {
  return (
    state.pendingSecret !== null ||
    state.pendingConfirmation !== null ||
    state.pendingContactRequest !== null ||
    state.pendingQuestion !== null
  );
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useInteractionStoreBase = create<InteractionStore>()((set, get) => ({
  ...INITIAL_STATE,

  claimSubmission: (kind, requestId) =>
    set((state) => ({
      submittingByKind: { ...state.submittingByKind, [kind]: requestId },
    })),

  // Only the holder may release, so a response that has been superseded cannot
  // reopen the double-submit guard for whoever holds it now. Returns `state`
  // itself for a non-holder rather than an empty patch: zustand skips the
  // notification only on an identical reference, and a superseded resume
  // calling this is the ordinary case, not the rare one.
  releaseSubmission: (kind, requestId) =>
    set((state) =>
      state.submittingByKind[kind] === requestId
        ? { submittingByKind: { ...state.submittingByKind, [kind]: null } }
        : state,
    ),

  // ----- Secret -----
  showSecret: (payload) => {
    const { pendingSecret } = get();
    // A live `secret_request` SSE event arrives first with full metadata, then
    // a sparse rehydrate (`{ requestId }`) can fire for the same prompt. Merge
    // only the defined fields so the sparse rehydrate can't erase rich state.
    if (pendingSecret && pendingSecret.requestId === payload.requestId) {
      const defined: Partial<PendingSecretState> = {};
      for (const key of Object.keys(payload) as (keyof PendingSecretState)[]) {
        if (payload[key] !== undefined) {
          (defined[key] as unknown) = payload[key];
        }
      }
      set({ pendingSecret: { ...pendingSecret, ...defined } });
      return;
    }
    set({ pendingSecret: payload, secretSaved: false });
  },

  setSecretSavedIfMatches: (requestId, saved) => {
    const { pendingSecret } = get();
    if (!pendingSecret || pendingSecret.requestId !== requestId) {
      return;
    }
    set({ secretSaved: saved });
  },

  dismissSecretIfMatches: (requestId) => {
    const { pendingSecret } = get();
    if (!pendingSecret || pendingSecret.requestId !== requestId) {
      return;
    }
    set({ pendingSecret: null });
  },

  updateSecret: (requestId, patch) => {
    const { pendingSecret } = get();
    if (!pendingSecret || pendingSecret.requestId !== requestId) {
      return;
    }
    set({ pendingSecret: { ...pendingSecret, ...patch } });
  },

  // ----- Confirmation -----
  showConfirmation: (payload) => set({ pendingConfirmation: payload }),

  // Retiring is by request only. There is deliberately no "dismiss whatever is
  // on screen": a caller holding a stale request could use it to close a card
  // it never decided, which is the shape of every bug this slot has had.
  dismissConfirmationIfMatches: (requestId) => {
    const { pendingConfirmation } = get();
    if (!pendingConfirmation || pendingConfirmation.requestId !== requestId) {
      return;
    }
    set({ pendingConfirmation: null });
  },

  updateConfirmation: (requestId, patch) => {
    const { pendingConfirmation } = get();
    if (!pendingConfirmation || pendingConfirmation.requestId !== requestId) {
      return;
    }
    set({ pendingConfirmation: { ...pendingConfirmation, ...patch } });
  },

  setInlineConfirmationToolCallId: (toolCallId) =>
    set({ inlineConfirmationToolCallId: toolCallId }),

  releaseInlineAnchorIfMatches: (toolCallId) => {
    if (!toolCallId || get().inlineConfirmationToolCallId !== toolCallId) {
      return;
    }
    set({ inlineConfirmationToolCallId: null });
  },

  // ----- Contact request -----
  showContactRequest: (payload) =>
    set({ pendingContactRequest: payload, contactRequestAccepted: false }),

  dismissContactRequestIfMatches: (requestId) => {
    const { pendingContactRequest } = get();
    if (
      !pendingContactRequest ||
      pendingContactRequest.requestId !== requestId
    ) {
      return;
    }
    set({ pendingContactRequest: null });
  },

  acceptContactRequest: () => set({ contactRequestAccepted: true }),

  // ----- Question -----
  showQuestion: (payload) =>
    set((state) => ({
      pendingQuestion: payload,
      questionRevision: state.questionRevision + 1,
      isQuestionCardDismissed: false,
    })),

  dismissQuestionIfMatches: (requestId) => {
    const { pendingQuestion } = get();
    if (!pendingQuestion || pendingQuestion.requestId !== requestId) {
      return;
    }
    set((state) => ({
      pendingQuestion: null,
      questionRevision: state.questionRevision + 1,
      isQuestionCardDismissed: false,
    }));
  },

  dismissQuestionCard: () => set({ isQuestionCardDismissed: true }),

  // ----- Resets -----
  resetSecretAndConfirmation: () =>
    set((state) => ({
      pendingSecret: null,
      secretSaved: false,
      pendingConfirmation: null,
      inlineConfirmationToolCallId: null,
      // A reset abandons the interaction outright, which is the one thing that
      // legitimately ends someone else's submission.
      submittingByKind: {
        ...state.submittingByKind,
        secret: null,
        confirmation: null,
      },
      // Question state is intentionally not cleared: the daemon blocks on
      // /question-response until the prompt settles, and clearing here would
      // hide a card that is still answerable. A question that the daemon does
      // settle retires through `dismissQuestionIfMatches`, driven by the
      // `interaction_resolved` handler and the 404 paths in `question-actions`.
    })),

  // ----- ACP Connect Claude prompt -----
  // Skip a restore the user already dismissed this session. The live-failure
  // path passes a fresh tool-use id (never dismissed), so only history reseeds
  // of an already-handled failure are suppressed.
  setAcpConnectFlowActive: (active) => set({ acpConnectFlowActive: active }),

  setAcpConnectPlacement: (placement) =>
    set((state) =>
      state.acpConnectPlacement?.toolUseId === placement?.toolUseId &&
      state.acpConnectPlacement?.placement === placement?.placement
        ? state
        : { acpConnectPlacement: placement },
    ),

  showAcpConnect: (payload, opts) =>
    set((state) => {
      // Not while the user is part-way through connecting from another card.
      // Replacing the prompt moves the affordance to a different anchor row,
      // which unmounts the one that owns the OAuth flow: the loopback poll is
      // invalidated and the manual paste state goes with it, so a sign-in in
      // progress cannot finish. The newer failure has a marker of its own, so
      // a snapshot surfaces it once this flow settles and the card clears.
      //
      // First, ahead of every path that can replace the prompt. A live event
      // superseding a dismissal is one of them, so a guard placed after that
      // branch is a guard the live path walks around.
      if (
        state.acpConnectFlowActive &&
        state.pendingAcpConnect &&
        state.pendingAcpConnect.toolUseId !== payload.toolUseId
      ) {
        return state;
      }
      if (state.dismissedAcpConnectToolUseIds.has(payload.toolUseId)) {
        if (!opts?.supersedesDismissal) {
          return state;
        }
        // A new rejection under an anchor the user dismissed. Forget the
        // dismissal with it: keeping the id would suppress this card and every
        // later restore of it, and the run has genuinely failed again.
        const dismissed = new Set(state.dismissedAcpConnectToolUseIds);
        dismissed.delete(payload.toolUseId);
        return {
          dismissedAcpConnectToolUseIds: dismissed,
          pendingAcpConnect: payload,
          acpConnectRevision: state.acpConnectRevision + 1,
        };
      }
      // The revision means "the prompt changed", and readers compare against
      // it to tell whether a response they issued still speaks for what is on
      // screen. Two fetches can capture the same revision, and an older marked
      // response re-raising the prompt already displayed would advance it and
      // make the later authoritative one look stale, leaving a repaired card
      // standing until the next navigation. Re-raising the same prompt is not
      // a change.
      const current = state.pendingAcpConnect;
      if (
        current &&
        current.toolUseId === payload.toolUseId &&
        current.reason === payload.reason &&
        current.conversationId === payload.conversationId
      ) {
        return state;
      }
      return {
        pendingAcpConnect: payload,
        acpConnectRevision: state.acpConnectRevision + 1,
      };
    }),

  adoptAcpConnectConversation: (conversationId) =>
    set((state) =>
      state.pendingAcpConnect && !state.pendingAcpConnect.conversationId
        ? {
            pendingAcpConnect: {
              ...state.pendingAcpConnect,
              conversationId,
            },
          }
        : state,
    ),

  // Remember which failed spawn was dismissed so a later reseed can't resurrect
  // it (the tool call's `errorCode` marker lives permanently in history).
  dismissAcpConnect: () =>
    set((state) => ({
      pendingAcpConnect: null,
      dismissedAcpConnectToolUseIds: state.pendingAcpConnect
        ? new Set(state.dismissedAcpConnectToolUseIds).add(
            state.pendingAcpConnect.toolUseId,
          )
        : state.dismissedAcpConnectToolUseIds,
    })),

  requestAcpContinue: () => set({ pendingAcpContinue: true }),

  clearAcpContinue: () => set({ pendingAcpContinue: false }),

  // ----- Nudge tracking -----
  addUnknownNudgeToolCallId: (toolCallId) => {
    const current = get().unknownNudgeToolCallIds;
    if (current.has(toolCallId)) {
      return;
    }
    set({ unknownNudgeToolCallIds: new Set([...current, toolCallId]) });
  },

  removeUnknownNudgeToolCallId: (toolCallId) => {
    const current = get().unknownNudgeToolCallIds;
    if (!current.has(toolCallId)) {
      return;
    }
    const next = new Set(current);
    next.delete(toolCallId);
    set({ unknownNudgeToolCallIds: next });
  },

  // Per-conversation interaction state resets on navigation, with one
  // exemption: the Connect Claude prompt survives. Its card renders only
  // under the transcript row matching its tool-use anchor, so display is
  // already conversation-scoped, and the post-spawn auth_required prompt has
  // no other copy (its spawn tool call succeeded, so message history cannot
  // rebuild it). Clearing it here would permanently orphan the transcript
  // guidance that points at the card. The dismissed set still resets, so a
  // returned-to conversation can re-raise from history.
  resetAll: () =>
    set((state) => ({
      ...INITIAL_STATE,
      pendingAcpConnect: state.pendingAcpConnect,
      // A conversation switch drops the card, which is a change like any other:
      // carry the counters forward and advance them rather than restarting
      // from the initial zero. Restarting would let a read issued before the
      // switch compare equal to the state after it.
      //
      // The ACP counter needs this more than the question one does, because
      // `pendingAcpConnect` is carried across the switch: a snapshot fetched
      // before it, comparing equal against a restarted counter, would retire a
      // prompt raised in the meantime and record its tool-use id as dismissed,
      // which stops any later snapshot from restoring the card at all.
      questionRevision: state.questionRevision + 1,
      acpConnectRevision: state.acpConnectRevision + 1,
    })),
}));

export const useInteractionStore = createSelectors(useInteractionStoreBase);

/**
 * Whether a question card is on screen. A boolean rather than the state
 * itself, so a subscriber that only cares that one is up does not re-render
 * every time its contents change.
 */
export function useHasPendingQuestion(): boolean {
  return useInteractionStore((state) => state.pendingQuestion !== null);
}

/** Atomic per-kind subscription, so a card re-renders only for its own kind. */
export function useSubmittingRequestId(kind: PromptKind): string | null {
  return useInteractionStore((state) => state.submittingByKind[kind]);
}
