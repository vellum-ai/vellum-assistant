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
  pendingSecret: PendingSecretState | null;
  isSubmittingSecret: boolean;
  secretSaved: boolean;

  pendingConfirmation: PendingConfirmationState | null;
  isSubmittingConfirmation: boolean;

  pendingContactRequest: PendingContactRequestState | null;
  isSubmittingContactRequest: boolean;
  contactRequestAccepted: boolean;

  pendingQuestion: PendingQuestionState | null;
  isSubmittingQuestion: boolean;
  /** When true, the question card is hidden but `pendingQuestion` stays set
   *  so the composer free-text intercept still routes to `submitQuestionResponse`. */
  isQuestionCardDismissed: boolean;

  inlineConfirmationToolCallId: string | null;

  /**
   * A missing-token `acp_spawn` failure raised an inline "Connect Claude Code"
   * prompt, anchored to the failed tool call. Unlike the other prompts this is
   * NOT a turn-blocking interaction — the turn already ended in error; it is a
   * remediation CTA. It is restored on a `/messages` reseed from the failed
   * tool call's persisted `errorCode` marker (so a reload/reconnect no longer
   * loses it), but to avoid nagging from history — the reason it was originally
   * kept off the reseed path — a dismissal (explicit X, or the implicit
   * dismiss-on-send) is recorded in `dismissedAcpConnectToolUseIds` and
   * suppresses any later restore of that same failed spawn.
   */
  pendingAcpConnect: PendingAcpConnectState | null;

  /**
   * Failed-`acp_spawn` tool-call ids whose Connect prompt the user already
   * dealt with this session (dismissed via X or superseded by a send). The
   * `errorCode` marker lives permanently in history, so without this a reseed
   * would re-raise the card on every turn until Claude is connected; recording
   * the id lets `showAcpConnect` no-op a restore the user already dismissed. A
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
  // Secret
  showSecret: (payload: PendingSecretState) => void;
  submitSecretStart: () => void;
  submitSecretEnd: (saved?: boolean) => void;
  dismissSecret: () => void;
  updateSecret: (requestId: string, patch: Partial<PendingSecretState>) => void;

  // Confirmation
  showConfirmation: (payload: PendingConfirmationState) => void;
  submitConfirmationStart: () => void;
  submitConfirmationEnd: () => void;
  dismissConfirmation: () => void;
  dismissConfirmationIfMatches: (requestId: string) => void;
  updateConfirmation: (requestId: string, patch: Partial<PendingConfirmationState>) => void;
  setInlineConfirmationToolCallId: (toolCallId: string | null) => void;

  // Contact request
  showContactRequest: (payload: PendingContactRequestState) => void;
  submitContactRequestStart: () => void;
  submitContactRequestEnd: () => void;
  dismissContactRequest: () => void;
  acceptContactRequest: () => void;

  // Question
  showQuestion: (payload: PendingQuestionState) => void;
  submitQuestionStart: () => void;
  submitQuestionEnd: () => void;
  dismissQuestion: () => void;
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
  pendingSecret: null,
  isSubmittingSecret: false,
  secretSaved: false,

  pendingConfirmation: null,
  isSubmittingConfirmation: false,

  pendingContactRequest: null,
  isSubmittingContactRequest: false,
  contactRequestAccepted: false,

  pendingQuestion: null,
  isSubmittingQuestion: false,
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
    set({ pendingSecret: payload, isSubmittingSecret: false, secretSaved: false });
  },

  submitSecretStart: () =>
    set({ isSubmittingSecret: true }),

  submitSecretEnd: (saved) =>
    set({ isSubmittingSecret: false, secretSaved: saved ?? false }),

  dismissSecret: () =>
    set({ pendingSecret: null, isSubmittingSecret: false }),

  updateSecret: (requestId, patch) => {
    const { pendingSecret } = get();
    if (!pendingSecret || pendingSecret.requestId !== requestId) return;
    set({ pendingSecret: { ...pendingSecret, ...patch } });
  },

  // ----- Confirmation -----
  showConfirmation: (payload) =>
    set({ pendingConfirmation: payload, isSubmittingConfirmation: false }),

  submitConfirmationStart: () =>
    set({ isSubmittingConfirmation: true }),

  submitConfirmationEnd: () =>
    set({ isSubmittingConfirmation: false }),

  dismissConfirmation: () =>
    set({ pendingConfirmation: null, isSubmittingConfirmation: false }),

  dismissConfirmationIfMatches: (requestId) => {
    const { pendingConfirmation } = get();
    if (!pendingConfirmation || pendingConfirmation.requestId !== requestId) return;
    set({ pendingConfirmation: null, isSubmittingConfirmation: false });
  },

  updateConfirmation: (requestId, patch) => {
    const { pendingConfirmation } = get();
    if (!pendingConfirmation || pendingConfirmation.requestId !== requestId) return;
    set({ pendingConfirmation: { ...pendingConfirmation, ...patch } });
  },

  setInlineConfirmationToolCallId: (toolCallId) =>
    set({ inlineConfirmationToolCallId: toolCallId }),

  // ----- Contact request -----
  showContactRequest: (payload) =>
    set({
      pendingContactRequest: payload,
      isSubmittingContactRequest: false,
      contactRequestAccepted: false,
    }),

  submitContactRequestStart: () =>
    set({ isSubmittingContactRequest: true }),

  submitContactRequestEnd: () =>
    set({ isSubmittingContactRequest: false }),

  dismissContactRequest: () =>
    set({ pendingContactRequest: null, isSubmittingContactRequest: false }),

  acceptContactRequest: () =>
    set({ contactRequestAccepted: true }),

  // ----- Question -----
  showQuestion: (payload) =>
    set({ pendingQuestion: payload, isSubmittingQuestion: false, isQuestionCardDismissed: false }),

  submitQuestionStart: () =>
    set({ isSubmittingQuestion: true }),

  submitQuestionEnd: () =>
    set({ isSubmittingQuestion: false }),

  dismissQuestion: () =>
    set({ pendingQuestion: null, isSubmittingQuestion: false, isQuestionCardDismissed: false }),

  dismissQuestionCard: () =>
    set({ isQuestionCardDismissed: true }),

  // ----- Resets -----
  resetSecretAndConfirmation: () =>
    set({
      pendingSecret: null,
      isSubmittingSecret: false,
      secretSaved: false,
      pendingConfirmation: null,
      isSubmittingConfirmation: false,
      inlineConfirmationToolCallId: null,
      // Question state intentionally NOT cleared — the composer intercept
      // (`pendingQuestion && trimmed`) only fires for text sends; clearing
      // the question would hide the card while the daemon blocks on
      // /question-response/.
    }),

  // ----- ACP Connect Claude prompt -----
  // Skip a restore the user already dismissed this session. The live-failure
  // path passes a fresh tool-use id (never dismissed), so only history reseeds
  // of an already-handled failure are suppressed.
  showAcpConnect: (payload) =>
    set((state) =>
      state.dismissedAcpConnectToolUseIds.has(payload.toolUseId)
        ? {}
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
    if (current.has(toolCallId)) return;
    set({ unknownNudgeToolCallIds: new Set([...current, toolCallId]) });
  },

  removeUnknownNudgeToolCallId: (toolCallId) => {
    const current = get().unknownNudgeToolCallIds;
    if (!current.has(toolCallId)) return;
    const next = new Set(current);
    next.delete(toolCallId);
    set({ unknownNudgeToolCallIds: next });
  },

  resetAll: () => set(INITIAL_STATE),
}));

export const useInteractionStore = createSelectors(useInteractionStoreBase);
