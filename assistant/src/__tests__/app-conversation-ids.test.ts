import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  addAppConversationId,
  createApp,
  getApp,
  isDirectAppConversation,
  linkAppToConversationLineage,
  listAppsByConversation,
} from "../apps/app-store.js";
import {
  deleteConversation,
  removeSubagentConversation,
  setConversation,
  setSubagentConversation,
} from "../daemon/conversation-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDataDir: string;

/**
 * The registry stores live `Conversation` instances; lineage resolution only
 * reads `parentConversationId`, so a minimal stand-in is enough.
 */
type RegistryConversation = Parameters<typeof setConversation>[1];

const registeredTopLevel: string[] = [];
const registeredSubagents: [string, RegistryConversation][] = [];

function stubConversation(parentConversationId?: string): RegistryConversation {
  return { parentConversationId } as unknown as RegistryConversation;
}

/** Register a resident top-level conversation, optionally forked from a parent. */
function registerConversation(id: string, parentId?: string): void {
  setConversation(id, stubConversation(parentId));
  registeredTopLevel.push(id);
}

/** Register a live subagent conversation forked from `parentId`. */
function registerSubagent(id: string, parentId: string): void {
  const conversation = stubConversation(parentId);
  setSubagentConversation(id, conversation);
  registeredSubagents.push([id, conversation]);
}

function clearRegisteredConversations(): void {
  for (const id of registeredTopLevel.splice(0)) {
    deleteConversation(id);
  }
  for (const [id, conversation] of registeredSubagents.splice(0)) {
    removeSubagentConversation(id, conversation);
  }
}

function freshTempDir(): string {
  return join(
    tmpdir(),
    `vellum-app-conv-id-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

function makeAppParams(name: string) {
  return {
    name,
    schemaJson: "{}",
    htmlDefinition: "<h1>Hello</h1>",
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  testDataDir = freshTempDir();
  process.env.VELLUM_WORKSPACE_DIR = testDataDir;
});

afterEach(() => {
  clearRegisteredConversations();
  if (existsSync(testDataDir)) {
    rmSync(testDataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// addAppConversationId
// ---------------------------------------------------------------------------

describe("addAppConversationId", () => {
  test("appends conversationId and returns true", () => {
    const app = createApp(makeAppParams("Test App"));
    const result = addAppConversationId(app.id, "conv-abc");
    expect(result).toBe(true);

    const loaded = getApp(app.id);
    expect(loaded?.conversationIds).toEqual(["conv-abc"]);
  });

  test("deduplicates — returns false when conversationId already present", () => {
    const app = createApp(makeAppParams("Test App"));
    addAppConversationId(app.id, "conv-abc");
    const result = addAppConversationId(app.id, "conv-abc");
    expect(result).toBe(false);

    const loaded = getApp(app.id);
    expect(loaded?.conversationIds).toEqual(["conv-abc"]);
  });

  test("returns false for non-existent app", () => {
    const result = addAppConversationId("nonexistent-id", "conv-abc");
    expect(result).toBe(false);
  });

  test("does not change updatedAt", () => {
    const app = createApp(makeAppParams("Test App"));
    const originalUpdatedAt = app.updatedAt;

    // Wait a tick so Date.now() would differ if updatedAt were bumped
    const before = Date.now();
    while (Date.now() === before) {
      // busy-wait for at least 1ms
    }

    addAppConversationId(app.id, "conv-abc");

    const loaded = getApp(app.id);
    expect(loaded?.updatedAt).toBe(originalUpdatedAt);
  });

  test("initializes conversationIds from undefined", () => {
    const app = createApp(makeAppParams("Fresh App"));
    // Verify the app has no conversationIds initially
    const initial = getApp(app.id);
    expect(initial?.conversationIds).toBeUndefined();

    addAppConversationId(app.id, "conv-xyz");

    const loaded = getApp(app.id);
    expect(loaded?.conversationIds).toEqual(["conv-xyz"]);
  });

  test("appends multiple distinct conversationIds", () => {
    const app = createApp(makeAppParams("Multi Conv App"));
    addAppConversationId(app.id, "conv-1");
    addAppConversationId(app.id, "conv-2");
    addAppConversationId(app.id, "conv-3");

    const loaded = getApp(app.id);
    expect(loaded?.conversationIds).toEqual(["conv-1", "conv-2", "conv-3"]);
  });
});

// ---------------------------------------------------------------------------
// listAppsByConversation
// ---------------------------------------------------------------------------

describe("listAppsByConversation", () => {
  test("filters apps by conversationId", () => {
    const app1 = createApp(makeAppParams("App One"));
    const app2 = createApp(makeAppParams("App Two"));
    createApp(makeAppParams("App Three"));

    addAppConversationId(app1.id, "conv-shared");
    addAppConversationId(app2.id, "conv-shared");
    addAppConversationId(app1.id, "conv-only-one");

    const shared = listAppsByConversation("conv-shared");
    expect(shared).toHaveLength(2);
    const ids = shared.map((a) => a.id).sort();
    expect(ids).toEqual([app1.id, app2.id].sort());

    const onlyOne = listAppsByConversation("conv-only-one");
    expect(onlyOne).toHaveLength(1);
    expect(onlyOne[0].id).toBe(app1.id);
  });

  test("returns empty array for unknown conversationId", () => {
    createApp(makeAppParams("Some App"));
    const result = listAppsByConversation("conv-nonexistent");
    expect(result).toEqual([]);
  });

  test("returns empty array when no apps exist", () => {
    const result = listAppsByConversation("conv-any");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// linkAppToConversationLineage
// ---------------------------------------------------------------------------

describe("linkAppToConversationLineage", () => {
  test("an app created in a forked conversation carries the fork and its parent", () => {
    registerConversation("conv-visible");
    registerSubagent("conv-fork", "conv-visible");

    const app = createApp(makeAppParams("Continuation App"));
    linkAppToConversationLineage(app.id, "conv-fork");

    expect(getApp(app.id)?.conversationIds).toEqual([
      "conv-fork",
      "conv-visible",
    ]);
  });

  test("the user-visible ancestor lists an app created by a background subagent", () => {
    registerConversation("conv-visible");
    registerSubagent("conv-fork", "conv-visible");

    const app = createApp(makeAppParams("Continuation App"));
    linkAppToConversationLineage(app.id, "conv-fork");

    const visible = listAppsByConversation("conv-visible");
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe(app.id);
  });

  test("walks nested subagents up to the user-visible thread", () => {
    registerConversation("conv-visible");
    registerSubagent("conv-outer", "conv-visible");
    registerSubagent("conv-inner", "conv-outer");

    const app = createApp(makeAppParams("Nested App"));
    linkAppToConversationLineage(app.id, "conv-inner");

    expect(getApp(app.id)?.conversationIds).toEqual([
      "conv-inner",
      "conv-outer",
      "conv-visible",
    ]);
  });

  test("re-linking the same lineage is idempotent", () => {
    registerConversation("conv-visible");
    registerSubagent("conv-fork", "conv-visible");

    const app = createApp(makeAppParams("Repeat App"));
    linkAppToConversationLineage(app.id, "conv-fork");
    linkAppToConversationLineage(app.id, "conv-fork");

    expect(getApp(app.id)?.conversationIds).toEqual([
      "conv-fork",
      "conv-visible",
    ]);
  });

  test("a lineage of one behaves exactly like addAppConversationId", () => {
    registerConversation("conv-plain");

    const linked = createApp(makeAppParams("Linked App"));
    const direct = createApp(makeAppParams("Direct App"));
    linkAppToConversationLineage(linked.id, "conv-plain");
    addAppConversationId(direct.id, "conv-plain");

    expect(getApp(linked.id)?.conversationIds).toEqual(["conv-plain"]);
    expect(getApp(direct.id)?.conversationIds).toEqual(
      getApp(linked.id)?.conversationIds,
    );
    expect(listAppsByConversation("conv-plain")).toHaveLength(2);
  });

  test("an unregistered conversation links only itself", () => {
    const app = createApp(makeAppParams("Orphan App"));
    linkAppToConversationLineage(app.id, "conv-gone");

    expect(getApp(app.id)?.conversationIds).toEqual(["conv-gone"]);
  });

  test("a non-existent app is a no-op", () => {
    registerConversation("conv-visible");
    registerSubagent("conv-fork", "conv-visible");

    expect(() =>
      linkAppToConversationLineage("nonexistent-id", "conv-fork"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Direct vs inherited associations
// ---------------------------------------------------------------------------

describe("isDirectAppConversation", () => {
  test("the seed conversation is direct and its ancestors are inherited", () => {
    registerConversation("conv-visible");
    registerSubagent("conv-fork", "conv-visible");

    const app = createApp(makeAppParams("Continuation App"));
    linkAppToConversationLineage(app.id, "conv-fork");

    const loaded = getApp(app.id)!;
    expect(loaded.inheritedConversationIds).toEqual(["conv-visible"]);
    expect(isDirectAppConversation(loaded, "conv-fork")).toBe(true);
    expect(isDirectAppConversation(loaded, "conv-visible")).toBe(false);
  });

  test("an inherited association still lists the app in the ancestor thread", () => {
    registerConversation("conv-visible");
    registerSubagent("conv-fork", "conv-visible");

    const app = createApp(makeAppParams("Continuation App"));
    linkAppToConversationLineage(app.id, "conv-fork");

    expect(listAppsByConversation("conv-visible").map((a) => a.id)).toEqual([
      app.id,
    ]);
  });

  test("a record carrying no inherited list treats every association as direct", () => {
    const app = createApp(makeAppParams("Plain App"));
    addAppConversationId(app.id, "conv-plain");

    const loaded = getApp(app.id)!;
    expect(loaded.inheritedConversationIds).toBeUndefined();
    expect(isDirectAppConversation(loaded, "conv-plain")).toBe(true);
  });

  test("a direct association supersedes an earlier inherited one", () => {
    registerConversation("conv-visible");
    registerSubagent("conv-fork", "conv-visible");

    const app = createApp(makeAppParams("Adopted App"));
    linkAppToConversationLineage(app.id, "conv-fork");
    // The user later works on the same app in the thread they can see.
    expect(addAppConversationId(app.id, "conv-visible")).toBe(false);

    const loaded = getApp(app.id)!;
    expect(loaded.conversationIds).toEqual(["conv-fork", "conv-visible"]);
    expect(loaded.inheritedConversationIds).toEqual([]);
    expect(isDirectAppConversation(loaded, "conv-visible")).toBe(true);
  });

  test("an inherited link never demotes an existing direct association", () => {
    registerConversation("conv-visible");
    registerSubagent("conv-fork", "conv-visible");

    const app = createApp(makeAppParams("Foreground App"));
    addAppConversationId(app.id, "conv-visible");
    linkAppToConversationLineage(app.id, "conv-fork");

    const loaded = getApp(app.id)!;
    expect(loaded.conversationIds).toEqual(["conv-visible", "conv-fork"]);
    expect(loaded.inheritedConversationIds).toBeUndefined();
    expect(isDirectAppConversation(loaded, "conv-visible")).toBe(true);
  });
});
