import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  addAppConversationId,
  createApp,
  getApp,
  listAppsByConversation,
} from "../memory/app-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDataDir: string;

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
