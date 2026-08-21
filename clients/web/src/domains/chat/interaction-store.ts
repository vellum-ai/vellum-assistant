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
  showAcpConnect: (payload: PendingAcpConnectState) => void;
  dismissAcpConnect: () => void;
  requestAcpContinue: () => void;
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
  showAcpConnect: (payload) =>
    set((state) =>
      state.dismissedAcpConnectToolUseIds.has(payload.toolUseId)
        ? state
        : { pendingAcpConnect: payload },
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
      // carry the counter forward and advance it rather than restarting from
      // the initial zero. Restarting would let a read issued before the switch
      // compare equal to the state after it.
      questionRevision: state.questionRevision + 1,
    })),
}));

export const useInteractionStore = createSelectors(useInteractionStoreBase);

/** Atomic per-kind subscription, so a card re-renders only for its own kind. */
export function useSubmittingRequestId(kind: PromptKind): string | null {
  return useInteractionStore((state) => state.submittingByKind[kind]);
}
