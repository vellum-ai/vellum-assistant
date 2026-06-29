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
});

describe("missingAppIdError", () => {
  test("is an actionable error result", () => {
    const result = missingAppIdError();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("app_create");
  });
});
