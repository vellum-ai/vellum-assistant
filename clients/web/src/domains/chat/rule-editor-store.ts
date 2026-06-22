/**
 * Zustand store for the trust-rule editor modal state.
 *
 * Owns `showRuleEditor`, `ruleEditorContext`, and `isSavingRule` — the UI
 * state that controls visibility and content of `ChatRuleEditorModal`.
 * A Zustand store ensures all consumers share the same state, so any
 * component can open the rule editor and `ChatMainPanel` (which
 * renders the modal) always sees the update.
 *
 * Also manages the suggestion abort controller to cancel in-flight LLM
 * suggestion fetches when the editor is dismissed or reopened.
 *
 * @see docs/STATE_MANAGEMENT.md — Zustand stores with direct named actions
 * @see https://zustand.docs.pmnd.rs/guides/updating-state
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import type { AllowlistOption, DirectoryScopeOption, ScopeOption } from "@/types/interaction-ui-types";
import type { TrustRuleItem, TrustRuleRisk, TrustRuleSuggestion } from "@/types/trust-rules";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for the trust-rule editor modal. */
export interface RuleEditorContext {
  requestId: string;
  toolName: string;
  riskLevel: TrustRuleRisk;
  allowlistOptions: AllowlistOption[];
  scopeOptions: ScopeOption[];
  directoryScopeOptions: DirectoryScopeOption[];
  commandText: string;
  commandDescription: string;
  existingRule?: TrustRuleItem;
  suggestion?: TrustRuleSuggestion;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface RuleEditorState {
  showRuleEditor: boolean;
  ruleEditorContext: RuleEditorContext | null;
  isSavingRule: boolean;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface RuleEditorActions {
  openRuleEditor: (context: RuleEditorContext) => void;
  updateRuleEditorContext: (patch: Partial<RuleEditorContext>) => void;
  setIsSavingRule: (saving: boolean) => void;
  dismissRuleEditor: () => void;
  /**
   * Abort any in-flight suggestion fetch. Called when the editor is
   * dismissed or reopened so a stale suggestion can't land.
   */
  abortSuggestion: () => void;
  /**
   * Register a new AbortController for the current suggestion fetch.
   * Returns the controller so callers can check its signal.
   */
  newSuggestionController: () => AbortController;
}

export type RuleEditorStore = RuleEditorState & RuleEditorActions;

// ---------------------------------------------------------------------------
// Module-level abort controller
// ---------------------------------------------------------------------------

let suggestionAbortController: AbortController | null = null;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: RuleEditorState = {
  showRuleEditor: false,
  ruleEditorContext: null,
  isSavingRule: false,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useRuleEditorStoreBase = create<RuleEditorStore>()((set, get) => ({
  ...INITIAL_STATE,

  openRuleEditor: (context) =>
    set({ showRuleEditor: true, ruleEditorContext: context }),

  updateRuleEditorContext: (patch) => {
    const current = get().ruleEditorContext;
    if (current) {
      set({ ruleEditorContext: { ...current, ...patch } });
    }
  },

  setIsSavingRule: (saving) => set({ isSavingRule: saving }),

  dismissRuleEditor: () => {
    suggestionAbortController?.abort();
    suggestionAbortController = null;
    set({ showRuleEditor: false, ruleEditorContext: null });
  },

  abortSuggestion: () => {
    suggestionAbortController?.abort();
    suggestionAbortController = null;
  },

  newSuggestionController: () => {
    suggestionAbortController?.abort();
    const controller = new AbortController();
    suggestionAbortController = controller;
    return controller;
  },
}));

export const useRuleEditorStore = createSelectors(useRuleEditorStoreBase);
