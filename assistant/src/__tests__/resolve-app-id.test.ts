import { describe, expect, mock, test } from "bun:test";

import type { AppDefinition } from "../apps/app-store.js";

let appsByConversation: AppDefinition[] = [];

const realStore = await import("../apps/app-store.js");
mock.module("../apps/app-store.js", () => ({
  ...realStore,
  listAppsByConversation: (_conversationId: string) => appsByConversation,
}));

const { resolveAppId, missingAppIdError } =
  await import("../tools/apps/resolve-app-id.js");

function makeApp(id: string, updatedAt: number): AppDefinition {
  return {
    id,
    name: id,
    schemaJson: "{}",
    htmlDefinition: "",
    createdAt: updatedAt,
    updatedAt,
  };
}

/** An app the conversation only reached through a descendant's lineage. */
function makeInheritedApp(
  id: string,
  updatedAt: number,
  conversationId: string,
): AppDefinition {
  return {
    ...makeApp(id, updatedAt),
    inheritedConversationIds: [conversationId],
  };
}

describe("resolveAppId", () => {
  test("returns an explicit non-empty app_id unchanged", () => {
    appsByConversation = [makeApp("other", 1)];
    expect(resolveAppId({ app_id: "explicit" }, "conv-1")).toBe("explicit");
  });

  test("falls back to the most-recently-updated conversation app when missing", () => {
    // listAppsByConversation inherits listApps' updatedAt-descending order.
    appsByConversation = [makeApp("newest", 30), makeApp("older", 10)];
    expect(resolveAppId({}, "conv-1")).toBe("newest");
  });

  test("treats a blank app_id as missing", () => {
    appsByConversation = [makeApp("active", 5)];
    expect(resolveAppId({ app_id: "   " }, "conv-1")).toBe("active");
  });

  test("returns null when no app_id is given and the conversation has no app", () => {
    appsByConversation = [];
    expect(resolveAppId({}, "conv-1")).toBeNull();
  });

  test("prefers a direct app over a more recent lineage-linked one", () => {
    // A background subagent's app is linked into the parent thread and, being
    // newest, heads the list — it must not capture the parent's implicit call.
    appsByConversation = [
      makeInheritedApp("background", 30, "conv-1"),
      makeApp("foreground", 10),
    ];
    expect(resolveAppId({}, "conv-1")).toBe("foreground");
  });

  test("falls back to a lineage-linked app when the conversation has no direct one", () => {
    appsByConversation = [makeInheritedApp("background", 30, "conv-1")];
    expect(resolveAppId({}, "conv-1")).toBe("background");
  });

  test("an app inherited by another conversation is direct here", () => {
    appsByConversation = [makeInheritedApp("shared", 30, "conv-other")];
    expect(resolveAppId({}, "conv-1")).toBe("shared");
  });
});

describe("missingAppIdError", () => {
  test("is an actionable error result", () => {
    const result = missingAppIdError();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("app_create");
  });
});
