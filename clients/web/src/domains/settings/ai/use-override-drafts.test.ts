/**
 * Tests for the Action Overrides save/reset serializers.
 *
 * `PATCH /v1/config` deep-merges, so the difference between a `null` value
 * and an absent key is the difference between deleting a call-site entry and
 * leaving it alone. These tests pin which rows land in which case.
 */

import { describe, expect, test } from "bun:test";

import {
  buildCallSiteSavePatch,
  buildResetPatch,
  type CallSiteDraftMap,
} from "@/domains/settings/ai/use-override-drafts";

// ---------------------------------------------------------------------------
// buildCallSiteSavePatch
// ---------------------------------------------------------------------------

describe("buildCallSiteSavePatch", () => {
  test("an active profile draft sends the picker fields with explicit nulls", () => {
    const drafts: CallSiteDraftMap = { workflowLeaf: { profile: "quality" } };
    const patch = buildCallSiteSavePatch(drafts, {});
    expect(patch.workflowLeaf).toEqual({
      profile: "quality",
      provider: null,
      model: null,
    });
  });

  test("an active custom draft sends the model with a null profile and provider", () => {
    // `provider: null` is an explicit clear: it scrubs a stale provider pin
    // persisted by an older daemon.
    const drafts: CallSiteDraftMap = {
      workflowLeaf: { model: "gpt-4o" },
    };
    const patch = buildCallSiteSavePatch(drafts, {});
    expect(patch.workflowLeaf).toEqual({
      profile: null,
      provider: null,
      model: "gpt-4o",
    });
  });

  test("an untouched legacy provider-only row is omitted, not rewritten", () => {
    // The row reads as active (old daemons still route on the pin), but the
    // serialized entry carries no provider: rewriting it without a user
    // edit would silently clear the pin.
    const drafts: CallSiteDraftMap = { heartbeatAgent: { provider: "openai" } };
    const patch = buildCallSiteSavePatch(drafts, {});
    expect("heartbeatAgent" in patch).toBe(false);
  });

  test("an edited legacy row serializes with the explicit provider clear", () => {
    const edited: CallSiteDraftMap = {
      heartbeatAgent: { provider: "openai", model: "gpt-4o" },
    };
    const patch = buildCallSiteSavePatch(edited, edited);
    expect(patch.heartbeatAgent).toEqual({
      profile: null,
      provider: null,
      model: "gpt-4o",
    });
  });

  test("a row switched off this session serializes to null", () => {
    const drafts: CallSiteDraftMap = { heartbeatAgent: null };
    const draftEdits: CallSiteDraftMap = { heartbeatAgent: null };
    const patch = buildCallSiteSavePatch(drafts, draftEdits);
    expect("heartbeatAgent" in patch).toBe(true);
    expect(patch.heartbeatAgent).toBe(null);
  });

  test("an inactive untouched row is absent from the patch", () => {
    // A persisted entry holding nothing but tuning reads as inactive. It is
    // omitted so the deep merge leaves the tuning in place; a `null` would
    // delete settings the user never asked to remove.
    const drafts: CallSiteDraftMap = {
      heartbeatAgent: { effort: "low", thinking: { enabled: false } },
      workflowLeaf: {},
    };
    const patch = buildCallSiteSavePatch(drafts, {});
    expect("heartbeatAgent" in patch).toBe(false);
    expect("workflowLeaf" in patch).toBe(false);
    expect(Object.keys(patch)).toEqual([]);
  });

  test("an active row and a switched-off row coexist without touching an untouched one", () => {
    const drafts: CallSiteDraftMap = {
      workflowLeaf: { profile: "quality" },
      heartbeatAgent: null,
      titleGenerator: { effort: "low" },
    };
    const draftEdits: CallSiteDraftMap = { heartbeatAgent: null };
    const patch = buildCallSiteSavePatch(drafts, draftEdits);
    expect(Object.keys(patch).sort()).toEqual([
      "heartbeatAgent",
      "workflowLeaf",
    ]);
    expect("titleGenerator" in patch).toBe(false);
  });

  test("an inactive row edited to something still inactive is omitted", () => {
    // `draftEdits[id]` is an empty draft rather than `null`, so it is not the
    // explicit "switch this off" signal and must not delete the entry.
    const drafts: CallSiteDraftMap = { heartbeatAgent: {} };
    const draftEdits: CallSiteDraftMap = { heartbeatAgent: {} };
    const patch = buildCallSiteSavePatch(drafts, draftEdits);
    expect("heartbeatAgent" in patch).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildResetPatch
// ---------------------------------------------------------------------------

describe("buildResetPatch", () => {
  test("nulls every draft key and nothing else", () => {
    const drafts: CallSiteDraftMap = {
      workflowLeaf: { profile: "quality" },
      heartbeatAgent: { effort: "low" },
      titleGenerator: null,
    };
    const patch = buildResetPatch(drafts);
    expect(Object.keys(patch).sort()).toEqual([
      "heartbeatAgent",
      "titleGenerator",
      "workflowLeaf",
    ]);
    expect(patch).toEqual({
      workflowLeaf: null,
      heartbeatAgent: null,
      titleGenerator: null,
    });
  });

  test("an empty draft map produces an empty patch", () => {
    expect(buildResetPatch({})).toEqual({});
  });
});
