import { describe, expect, test } from "bun:test";

import { decideGraduationDispatches } from "@/domains/chat/hooks/attention-tracking-utils";

// ---------------------------------------------------------------------------
// Tests for the graduation-decision helper used by `useAttentionTracking`.
//
// The helper signals "do nothing" by returning [] when `pendingKeys` is
// null (the hook passes null on bulk-fetch failure). Keys stay in
// `processingConversationIds` with their snapshots intact; the next render retries.
// Conversations with real pending approvals keep their processing indicator
// even when the bulk fetch fails.
// ---------------------------------------------------------------------------

describe("decideGraduationDispatches", () => {
  test("returns no actions when pendingKeys is null (bulk fetch failed)", () => {
    const actions = decideGraduationDispatches(
      ["conv-1", "conv-2", "conv-3"],
      null,
    );
    expect(actions).toEqual([]);
  });

  test("returns no actions when there are no graduating keys", () => {
    const actions = decideGraduationDispatches([], new Set(["conv-1"]));
    expect(actions).toEqual([]);
  });

  test("removes from processing without adding attention when nothing pending", () => {
    const actions = decideGraduationDispatches(
      ["conv-1", "conv-2"],
      new Set(),
    );
    expect(actions).toEqual([
      { type: "REMOVE_PROCESSING_KEY", key: "conv-1" },
      { type: "REMOVE_PROCESSING_KEY", key: "conv-2" },
    ]);
  });

  test("adds attention before removing processing for pending keys", () => {
    const actions = decideGraduationDispatches(
      ["conv-1"],
      new Set(["conv-1"]),
    );
    expect(actions).toEqual([
      { type: "ADD_ATTENTION_KEY", key: "conv-1" },
      { type: "REMOVE_PROCESSING_KEY", key: "conv-1" },
    ]);
  });

  test("interleaves attention + processing dispatches per key", () => {
    // A is pending, B is not, C is pending. The order matters: ADD before
    // REMOVE per-key so the red dot is set before the processing indicator
    // is dropped, leaving zero frames where the conversation has neither.
    const actions = decideGraduationDispatches(
      ["conv-a", "conv-b", "conv-c"],
      new Set(["conv-a", "conv-c"]),
    );
    expect(actions).toEqual([
      { type: "ADD_ATTENTION_KEY", key: "conv-a" },
      { type: "REMOVE_PROCESSING_KEY", key: "conv-a" },
      { type: "REMOVE_PROCESSING_KEY", key: "conv-b" },
      { type: "ADD_ATTENTION_KEY", key: "conv-c" },
      { type: "REMOVE_PROCESSING_KEY", key: "conv-c" },
    ]);
  });

  test("ignores pending keys that are not in the graduating list", () => {
    // Pending interactions can exist on conversations whose snapshots haven't
    // advanced yet (they're still streaming). Those don't graduate here —
    // the graduation effect only acts on keys that have actually finished a
    // turn.
    const actions = decideGraduationDispatches(
      ["conv-1"],
      new Set(["conv-1", "conv-99", "conv-100"]),
    );
    expect(actions).toEqual([
      { type: "ADD_ATTENTION_KEY", key: "conv-1" },
      { type: "REMOVE_PROCESSING_KEY", key: "conv-1" },
    ]);
  });

  test("empty pendingKeys Set is not the same as null", () => {
    // An empty Set means "fetch succeeded, nothing pending" — graduate
    // freely. Null means "fetch failed, don't graduate." The two cases
    // must stay distinct so a fetch failure does not silently drop
    // processing indicators.
    const successActions = decideGraduationDispatches(["conv-1"], new Set());
    const failureActions = decideGraduationDispatches(["conv-1"], null);
    expect(successActions).toEqual([
      { type: "REMOVE_PROCESSING_KEY", key: "conv-1" },
    ]);
    expect(failureActions).toEqual([]);
  });
});
