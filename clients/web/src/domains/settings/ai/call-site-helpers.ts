import type { CallSiteOverrideDraft } from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Sentinel value for the "Custom" profile picker option
// ---------------------------------------------------------------------------

export const CUSTOM_SENTINEL = "__custom__";

// ---------------------------------------------------------------------------
// Picker fields
// ---------------------------------------------------------------------------

/**
 * The three fields the Action Overrides pickers own. A persisted
 * `llm.callSites.<id>` entry may also carry tuning the UI has no control for
 * (`effort`, `thinking`, `maxTokens`, `temperature`, `contextWindow`, and the
 * rest of `CallSiteOverrideDraft`); the editor must carry those through
 * untouched.
 */
export type PickerSelection = Pick<
  CallSiteOverrideDraft,
  "profile" | "provider" | "model"
>;

/**
 * Apply a picker selection to a draft, preserving every other field on it.
 *
 * The picker triple is normalized to explicit `null` rather than omitted:
 * `PATCH /v1/config` deep-merges, so an absent `provider` would leave a
 * previously-persisted provider in place instead of clearing it. Fields
 * outside the triple are spread through precisely because that same
 * deep-merge would otherwise preserve them anyway - sending them back
 * unchanged keeps the serialized entry a faithful copy of what the editor
 * was handed, so a caller can compare or replace the whole object without
 * having to know which fields the UI happens to render.
 */
export function withPickerSelection(
  draft: CallSiteOverrideDraft | null | undefined,
  selection: PickerSelection,
): CallSiteOverrideDraft {
  return {
    ...(draft ?? {}),
    profile: selection.profile ?? null,
    provider: selection.provider ?? null,
    model: selection.model ?? null,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isDraftActive(
  d: CallSiteOverrideDraft | null | undefined,
): boolean {
  if (!d) {
    return false;
  }
  return !!(d.profile || d.provider || d.model);
}

export function draftsEqual(
  a: CallSiteOverrideDraft | null | undefined,
  b: CallSiteOverrideDraft | null | undefined,
): boolean {
  const aActive = isDraftActive(a);
  const bActive = isDraftActive(b);
  if (aActive !== bActive) {
    return false;
  }
  if (!aActive) {
    return true;
  }
  return (
    (a?.profile ?? null) === (b?.profile ?? null) &&
    (a?.provider ?? null) === (b?.provider ?? null) &&
    (a?.model ?? null) === (b?.model ?? null)
  );
}
