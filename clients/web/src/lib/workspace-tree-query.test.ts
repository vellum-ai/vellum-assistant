import { describe, expect, test } from "bun:test";

import {
  WORKSPACE_TREE_QUERY_KEY,
  workspaceTreeQueryOptions,
} from "@/lib/workspace-tree-query";

const ASSISTANT_ID = "assistant-1";

describe("workspaceTreeQueryOptions", () => {
  test("keys are prefixed so mutation invalidation reaches every reader", () => {
    const { queryKey } = workspaceTreeQueryOptions({
      assistantId: ASSISTANT_ID,
      path: "drafts",
    });

    expect(queryKey[0]).toBe(WORKSPACE_TREE_QUERY_KEY);
  });

  test("omitted flags and explicit falsy flags share one cache entry", () => {
    // The workspace browser passes its flags explicitly; chat's path links
    // omit them. Both describe the same request, so they must not split into
    // separate entries.
    const omitted = workspaceTreeQueryOptions({
      assistantId: ASSISTANT_ID,
      path: "drafts",
    }).queryKey;
    const explicit = workspaceTreeQueryOptions({
      assistantId: ASSISTANT_ID,
      path: "drafts",
      showHidden: false,
      includeDirSizes: false,
    }).queryKey;

    expect(omitted).toEqual(explicit);
  });

  test("an omitted path is the workspace root", () => {
    const omitted = workspaceTreeQueryOptions({
      assistantId: ASSISTANT_ID,
    }).queryKey;
    const empty = workspaceTreeQueryOptions({
      assistantId: ASSISTANT_ID,
      path: "",
    }).queryKey;

    expect(omitted).toEqual(empty);
  });

  test("directory, assistant, and flags each scope the entry", () => {
    const base = workspaceTreeQueryOptions({
      assistantId: ASSISTANT_ID,
      path: "drafts",
    }).queryKey;

    expect(base).not.toEqual(
      workspaceTreeQueryOptions({ assistantId: ASSISTANT_ID, path: "logs" })
        .queryKey,
    );
    expect(base).not.toEqual(
      workspaceTreeQueryOptions({ assistantId: "assistant-2", path: "drafts" })
        .queryKey,
    );
    expect(base).not.toEqual(
      workspaceTreeQueryOptions({
        assistantId: ASSISTANT_ID,
        path: "drafts",
        showHidden: true,
      }).queryKey,
    );
  });
});
