/**
 * Interaction-level state machine for user-facing prompts.
 *
 * Consolidates pending secret, confirmation, and contact-request state into a
 * single reducer with typed domain events and pure transitions.  Follows the
 * same pattern as the turn state machine (`turn-state-machine.ts`).
 *
 * @see https://react.dev/learn/extracting-state-logic-into-a-reducer
 * @see https://react.dev/learn/scaling-up-with-reducer-and-context
 */

import type {
  PendingSecretState,
  PendingConfirmationState,
  PendingContactRequestState,
  PendingQuestionState,
} from "@/domains/chat/lib/chat-ui-types.js";

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
}

export const INITIAL_INTERACTION_STATE: InteractionState = {
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
// Domain events
// ---------------------------------------------------------------------------

export interface ShowSecret {
  type: "SHOW_SECRET";
  payload: PendingSecretState;
}

export interface SubmitSecretStart {
  type: "SUBMIT_SECRET_START";
}

export interface SubmitSecretEnd {
  type: "SUBMIT_SECRET_END";
  saved?: boolean;
}

export interface DismissSecret {
  type: "DISMISS_SECRET";
}

/** Conditionally update the pending secret — only applies if the current
 *  requestId matches, preventing stale updates from overwriting newer state. */
export interface UpdateSecret {
  type: "UPDATE_SECRET";
  requestId: string;
  patch: Partial<PendingSecretState>;
}

export interface ShowConfirmation {
  type: "SHOW_CONFIRMATION";
  payload: PendingConfirmationState;
}

export interface SubmitConfirmationStart {
  type: "SUBMIT_CONFIRMATION_START";
}

export interface SubmitConfirmationEnd {
  type: "SUBMIT_CONFIRMATION_END";
}

export interface DismissConfirmation {
  type: "DISMISS_CONFIRMATION";
}

/** Conditionally dismiss the pending confirmation — only clears if the current
 *  requestId matches, preventing a concurrent confirmation from being lost. */
export interface DismissConfirmationIfMatches {
  type: "DISMISS_CONFIRMATION_IF_MATCHES";
  requestId: string;
}

/** Conditionally update the pending confirmation — only applies if the current
 *  requestId matches. */
export interface UpdateConfirmation {
  type: "UPDATE_CONFIRMATION";
  requestId: string;
  patch: Partial<PendingConfirmationState>;
}

export interface SetInlineConfirmationToolCallId {
  type: "SET_INLINE_CONFIRMATION_TOOL_CALL_ID";
  toolCallId: string | null;
}

export interface ShowContactRequest {
  type: "SHOW_CONTACT_REQUEST";
  payload: PendingContactRequestState;
}

export interface SubmitContactRequestStart {
  type: "SUBMIT_CONTACT_REQUEST_START";
}

export interface SubmitContactRequestEnd {
  type: "SUBMIT_CONTACT_REQUEST_END";
}

export interface DismissContactRequest {
  type: "DISMISS_CONTACT_REQUEST";
}

export interface AcceptContactRequest {
  type: "ACCEPT_CONTACT_REQUEST";
}

export interface ShowQuestion {
  type: "SHOW_QUESTION";
  payload: PendingQuestionState;
}

export interface SubmitQuestionStart {
  type: "SUBMIT_QUESTION_START";
}

export interface SubmitQuestionEnd {
  type: "SUBMIT_QUESTION_END";
}

/** Clear question state entirely (e.g. after successful submission). */
export interface DismissQuestion {
  type: "DISMISS_QUESTION";
}

/** Hide the question card UI but keep `pendingQuestion` set so the
 *  composer free-text intercept still routes to `submitQuestionResponse`. */
export interface DismissQuestionCard {
  type: "DISMISS_QUESTION_CARD";
}

/** Clear secret and confirmation state only — used when sending a message.
 *  Preserves contact request state (the composer is still enabled during
 *  contact requests, so sending a message should not dismiss them). */
export interface ResetSecretAndConfirmation {
  type: "RESET_SECRET_AND_CONFIRMATION";
}

/** Clear all interaction state — used on conversation switch. */
export interface ResetAll {
  type: "RESET_ALL";
}

export type InteractionEvent =
  | ShowSecret
  | SubmitSecretStart
  | SubmitSecretEnd
  | DismissSecret
  | UpdateSecret
  | ShowConfirmation
  | SubmitConfirmationStart
  | SubmitConfirmationEnd
  | DismissConfirmation
  | DismissConfirmationIfMatches
  | UpdateConfirmation
  | SetInlineConfirmationToolCallId
  | ShowContactRequest
  | SubmitContactRequestStart
  | SubmitContactRequestEnd
  | DismissContactRequest
  | AcceptContactRequest
  | ShowQuestion
  | SubmitQuestionStart
  | SubmitQuestionEnd
  | DismissQuestion
  | DismissQuestionCard
  | ResetSecretAndConfirmation
  | ResetAll;

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function interactionReducer(
  state: InteractionState,
  event: InteractionEvent,
): InteractionState {
  switch (event.type) {
    // ----- Secret -----
    case "SHOW_SECRET":
      return {
        ...state,
        pendingSecret: event.payload,
        isSubmittingSecret: false,
        secretSaved: false,
      };

    case "SUBMIT_SECRET_START":
      return { ...state, isSubmittingSecret: true };

    case "SUBMIT_SECRET_END":
      return {
        ...state,
        isSubmittingSecret: false,
        secretSaved: event.saved ?? false,
      };

    case "DISMISS_SECRET":
      return {
        ...state,
        pendingSecret: null,
        isSubmittingSecret: false,
      };

    case "UPDATE_SECRET":
      if (!state.pendingSecret || state.pendingSecret.requestId !== event.requestId) {
        return state;
      }
      return {
        ...state,
        pendingSecret: { ...state.pendingSecret, ...event.patch },
      };

    // ----- Confirmation -----
    case "SHOW_CONFIRMATION":
      return {
        ...state,
        pendingConfirmation: event.payload,
        isSubmittingConfirmation: false,
      };

    case "SUBMIT_CONFIRMATION_START":
      return { ...state, isSubmittingConfirmation: true };

    case "SUBMIT_CONFIRMATION_END":
      return { ...state, isSubmittingConfirmation: false };

    case "DISMISS_CONFIRMATION":
      return {
        ...state,
        pendingConfirmation: null,
        isSubmittingConfirmation: false,
      };

    case "DISMISS_CONFIRMATION_IF_MATCHES":
      if (!state.pendingConfirmation || state.pendingConfirmation.requestId !== event.requestId) {
        return state;
      }
      return {
        ...state,
        pendingConfirmation: null,
        isSubmittingConfirmation: false,
      };

    case "UPDATE_CONFIRMATION":
      if (!state.pendingConfirmation || state.pendingConfirmation.requestId !== event.requestId) {
        return state;
      }
      return {
        ...state,
        pendingConfirmation: { ...state.pendingConfirmation, ...event.patch },
      };

    case "SET_INLINE_CONFIRMATION_TOOL_CALL_ID":
      return { ...state, inlineConfirmationToolCallId: event.toolCallId };

    // ----- Contact request -----
    case "SHOW_CONTACT_REQUEST":
      return {
        ...state,
        pendingContactRequest: event.payload,
        isSubmittingContactRequest: false,
        contactRequestAccepted: false,
      };

    case "SUBMIT_CONTACT_REQUEST_START":
      return { ...state, isSubmittingContactRequest: true };

    case "SUBMIT_CONTACT_REQUEST_END":
      return { ...state, isSubmittingContactRequest: false };

    case "DISMISS_CONTACT_REQUEST":
      return {
        ...state,
        pendingContactRequest: null,
        isSubmittingContactRequest: false,
      };

    case "ACCEPT_CONTACT_REQUEST":
      return { ...state, contactRequestAccepted: true };

    // ----- Question -----
    case "SHOW_QUESTION":
      return {
        ...state,
        pendingQuestion: event.payload,
        isSubmittingQuestion: false,
        isQuestionCardDismissed: false,
      };

    case "SUBMIT_QUESTION_START":
      return { ...state, isSubmittingQuestion: true };

    case "SUBMIT_QUESTION_END":
      return { ...state, isSubmittingQuestion: false };

    case "DISMISS_QUESTION":
      return {
        ...state,
        pendingQuestion: null,
        isSubmittingQuestion: false,
        isQuestionCardDismissed: false,
      };

    case "DISMISS_QUESTION_CARD":
      return { ...state, isQuestionCardDismissed: true };

    // ----- Reset -----
    case "RESET_SECRET_AND_CONFIRMATION":
      return {
        ...state,
        pendingSecret: null,
        isSubmittingSecret: false,
        secretSaved: false,
        pendingConfirmation: null,
        isSubmittingConfirmation: false,
        inlineConfirmationToolCallId: null,
        // Question state is intentionally NOT cleared here.  The composer
        // intercept (`pendingQuestion && trimmed`) only fires for text
        // sends; attachment-only sends bypass it and land here.  Clearing
        // the question would hide the card while the daemon is still
        // blocking on /question-response/, leaving the user with no way
        // to answer.  Question state is managed by its own events
        // (DISMISS_QUESTION, DISMISS_QUESTION_CARD).
      };

    case "RESET_ALL":
      return { ...INITIAL_INTERACTION_STATE };

    default:
      return state;
  }
}
