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
  showSecret: (payload) =>
    set({ pendingSecret: payload, isSubmittingSecret: false, secretSaved: false }),

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
