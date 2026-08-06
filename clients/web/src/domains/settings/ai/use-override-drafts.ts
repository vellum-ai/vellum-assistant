import { useCallback, useMemo, useState } from "react";

import {
  draftsEqual,
  isDraftActive,
} from "@/domains/settings/ai/call-site-helpers";
import type { CallSiteOverrideDraft } from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Call-site id to its draft override. `null` is an explicit "no override
 * here"; an empty object is a row that carries nothing.
 */
export type CallSiteDraftMap = Record<string, CallSiteOverrideDraft | null>;

export interface UseOverrideDraftsOptions {
  /** Ids of every call site the panel enumerates, in catalog order. */
  catalogCallSiteIds: string[];
  /** `llm.callSites` as the daemon currently persists it. */
  persistedOverrides: CallSiteDraftMap;
  /** `llm.advisorProfile` as the daemon currently persists it. */
  persistedAdvisor: string;
  /** True once both the call-site catalog and the daemon config have loaded. */
  isSeeded: boolean;
}

export interface OverrideDrafts {
  /** Persisted overrides merged with this session's edits, keyed by id. */
  drafts: CallSiteDraftMap;
  advisorProfile: string;
  advisorDirty: boolean;
  callSiteDraftsDirty: boolean;
  hasUnsavedDrafts: boolean;
  hasValidationError: boolean;
  setDraft: (id: string, draft: CallSiteOverrideDraft | null) => void;
  setAdvisor: (profile: string) => void;
  /**
   * Drop every session edit so each row falls back through to the persisted
   * override. Callers use this after a write they did not route through
   * `buildSavePatch`, so a touched-then-reverted row cannot pin a stale
   * value over the freshly persisted config.
   */
  clearEdits: () => void;
  buildSavePatch: () => CallSiteDraftMap;
  buildResetPatch: () => Record<string, null>;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serializes the draft map into the `llm.callSites` body of a
 * `PATCH /v1/config` request.
 */
export function buildCallSiteSavePatch(
  drafts: CallSiteDraftMap,
  draftEdits: CallSiteDraftMap,
): CallSiteDraftMap {
  // `PATCH /v1/config` deep-merges (`deepMergeOverwrite` in the daemon's
  // config loader), so an omitted key keeps its persisted value and a
  // `null` deletes the whole entry. Three cases follow from that:
  //
  //  - active draft: send the picker triple. Nulling provider/model
  //    clears a stale pin; any tuning the entry carries is untouched
  //    because it isn't mentioned.
  //  - the user switched this row off: send `null` and delete it. That
  //    is what off means.
  //  - inactive and untouched: omit it. `isDraftActive` only reads the
  //    picker triple, so an entry holding nothing but tuning reads as
  //    off; sending `null` for it would delete settings the user never
  //    asked to remove.
  const patch: CallSiteDraftMap = {};
  for (const id of Object.keys(drafts)) {
    const d = drafts[id] ?? null;
    if (isDraftActive(d)) {
      patch[id] = {
        profile: d?.profile ?? null,
        provider: d?.provider ?? null,
        model: d?.model ?? null,
      };
    } else if (id in draftEdits && draftEdits[id] === null) {
      patch[id] = null;
    }
  }
  return patch;
}

/**
 * Serializes a "Reset to Defaults" request: every enumerated call site is
 * nulled so the daemon deletes its entry and the action follows its default.
 */
export function buildResetPatch(
  drafts: CallSiteDraftMap,
): Record<string, null> {
  const resetPatch: Record<string, null> = {};
  for (const id of Object.keys(drafts)) {
    resetPatch[id] = null;
  }
  return resetPatch;
}

// ---------------------------------------------------------------------------
// useOverrideDrafts
// ---------------------------------------------------------------------------

/**
 * Owns the Action Overrides panel's draft model: the per-call-site edits and
 * the Advisor selection made this session, plus everything derived from them.
 *
 * A draft is the persisted value merged with this session's edit for that
 * row; a row the user never touched falls through to the persisted override
 * (or to an empty draft when there is none), so a config refetch is picked up
 * rather than pinned to a stale snapshot. The same rule governs the Advisor:
 * an untouched selection reads from `llm.advisorProfile`.
 *
 * `buildSavePatch` and `buildResetPatch` apply the serialization rules that
 * protect tuning-only entries: a persisted entry holding only tuning fields
 * reads as "off" and must be omitted from a save rather than nulled.
 *
 * Holds no side effects and issues no queries: the caller owns the mutation.
 */
export function useOverrideDrafts({
  catalogCallSiteIds,
  persistedOverrides,
  persistedAdvisor,
  isSeeded,
}: UseOverrideDraftsOptions): OverrideDrafts {
  const [draftEdits, setDraftEdits] = useState<CallSiteDraftMap>({});
  // `undefined` means "untouched this session": the row falls through to the
  // persisted `llm.advisorProfile` rather than pinning a stale snapshot.
  const [advisorEdit, setAdvisorEdit] = useState<string | undefined>(undefined);

  // Derive the full draft map: persisted server values merged with any
  // user edits made this session. When the user hasn't touched a row,
  // it falls through to the persisted override (or empty).
  const drafts = useMemo((): CallSiteDraftMap => {
    if (!isSeeded) {
      return {};
    }
    const merged: CallSiteDraftMap = {};
    for (const id of catalogCallSiteIds) {
      if (id in draftEdits) {
        merged[id] = draftEdits[id];
      } else {
        const persisted = persistedOverrides[id];
        merged[id] = persisted ? { ...persisted } : {};
      }
    }
    return merged;
  }, [isSeeded, catalogCallSiteIds, persistedOverrides, draftEdits]);

  const advisorProfile = advisorEdit ?? persistedAdvisor;
  const advisorDirty = advisorProfile !== persistedAdvisor;

  const callSiteDraftsDirty = useMemo(() => {
    if (!isSeeded) {
      return false;
    }
    for (const id of Object.keys(drafts)) {
      if (!draftsEqual(drafts[id], persistedOverrides[id])) {
        return true;
      }
    }
    return false;
  }, [isSeeded, drafts, persistedOverrides]);

  const hasUnsavedDrafts = advisorDirty || callSiteDraftsDirty;

  const hasValidationError = useMemo(
    () =>
      Object.values(drafts).some(
        (d) => isDraftActive(d) && !!d?.provider && !d?.model,
      ),
    [drafts],
  );

  const setDraft = useCallback(
    (id: string, draft: CallSiteOverrideDraft | null) => {
      setDraftEdits((prev) => ({ ...prev, [id]: draft }));
    },
    [],
  );

  const setAdvisor = useCallback((profile: string) => {
    setAdvisorEdit(profile);
  }, []);

  const clearEdits = useCallback(() => {
    setDraftEdits({});
    setAdvisorEdit(undefined);
  }, []);

  const savePatchBuilder = useCallback(
    () => buildCallSiteSavePatch(drafts, draftEdits),
    [drafts, draftEdits],
  );

  const resetPatchBuilder = useCallback(
    () => buildResetPatch(drafts),
    [drafts],
  );

  return {
    drafts,
    advisorProfile,
    advisorDirty,
    callSiteDraftsDirty,
    hasUnsavedDrafts,
    hasValidationError,
    setDraft,
    setAdvisor,
    clearEdits,
    buildSavePatch: savePatchBuilder,
    buildResetPatch: resetPatchBuilder,
  };
}
