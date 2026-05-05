import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  addAppConversationId,
  backfillAppConversationIds,
  createApp,
  getApp,
} from "../memory/app-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { rawRun } from "../memory/raw-query.js";

// Initialize db once for all tests
initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDataDir: string;

function freshTempDir(): string {
  return join(
    tmpdir(),
    `vellum-app-backfill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

function makeAppParams(name: string) {
  return {
    name,
    schemaJson: "{}",
    htmlDefinition: "<h1>Hello</h1>",
  };
}

/** Insert a message row with the given conversation_id and content JSON. */
function insertMessage(
  conversationId: string,
  content: unknown[],
  role = "assistant",
): void {
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const contentStr = JSON.stringify(content);
  rawRun(
    `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    id,
    conversationId,
    role,
    contentStr,
    Date.now(),
  );
}

/** Insert a conversation row so FK constraints are satisfied. */
function insertConversation(id: string): void {
  const now = Date.now();
  rawRun(
    `INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    id,
    "test",
    now,
    now,
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Clean database tables between tests
  const db = getDb();
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);

  // Fresh temp dir for app-store filesystem operations
  testDataDir = freshTempDir();
  process.env.VELLUM_WORKSPACE_DIR = testDataDir;
});

afterEach(() => {
  if (existsSync(testDataDir)) {
    rmSync(testDataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// backfillAppConversationIds
// ---------------------------------------------------------------------------

describe("backfillAppConversationIds", () => {
  test("populates conversationIds from ui_surface blocks in messages", () => {
    const app = createApp(makeAppParams("My App"));
    const convId = "conv-backfill-1";
    insertConversation(convId);

    // Insert a message with a ui_surface block referencing the app
    insertMessage(convId, [
      { type: "text", text: "Here is your app" },
      {
        type: "ui_surface",
        surfaceType: "dynamic_page",
        data: { appId: app.id, html: "<h1>App</h1>" },
      },
    ]);

    backfillAppConversationIds();

    const loaded = getApp(app.id);
    expect(loaded?.conversationIds).toEqual([convId]);
  });

  test("handles multiple apps and conversations", () => {
    const app1 = createApp(makeAppParams("App One"));
    const app2 = createApp(makeAppParams("App Two"));
    const conv1 = "conv-multi-1";
    const conv2 = "conv-multi-2";
    insertConversation(conv1);
    insertConversation(conv2);

    // app1 referenced in conv1 and conv2
    insertMessage(conv1, [
      {
        type: "ui_surface",
        surfaceType: "dynamic_page",
        data: { appId: app1.id, html: "<h1>A1</h1>" },
      },
    ]);
    insertMessage(conv2, [
      {
        type: "ui_surface",
        surfaceType: "dynamic_page",
        data: { appId: app1.id, html: "<h1>A1</h1>" },
      },
    ]);

    // app2 referenced only in conv2
    insertMessage(conv2, [
      {
        type: "ui_surface",
        surfaceType: "dynamic_page",
        data: { appId: app2.id, html: "<h1>A2</h1>" },
      },
    ]);

    backfillAppConversationIds();

    const loaded1 = getApp(app1.id);
    expect(loaded1?.conversationIds?.sort()).toEqual([conv1, conv2].sort());

    const loaded2 = getApp(app2.id);
    expect(loaded2?.conversationIds).toEqual([conv2]);
  });

  test("is idempotent — running twice does not duplicate associations", () => {
    const app = createApp(makeAppParams("Idempotent App"));
    const convId = "conv-idemp-1";
    insertConversation(convId);

    insertMessage(convId, [
      {
        type: "ui_surface",
        surfaceType: "dynamic_page",
        data: { appId: app.id, html: "<h1>App</h1>" },
      },
    ]);

    backfillAppConversationIds();
    backfillAppConversationIds();

    const loaded = getApp(app.id);
    expect(loaded?.conversationIds).toEqual([convId]);
  });

  test("apps with no message references remain unchanged", () => {
    const app = createApp(makeAppParams("Untouched App"));
    const convId = "conv-unrelated";
    insertConversation(convId);

    // Insert a message with no ui_surface blocks
    insertMessage(convId, [{ type: "text", text: "Hello world" }]);

    backfillAppConversationIds();

    const loaded = getApp(app.id);
    expect(loaded?.conversationIds).toBeUndefined();
  });

  test("skips malformed message rows without error", () => {
    const app = createApp(makeAppParams("Robust App"));
    const convId = "conv-malformed";
    insertConversation(convId);

    // Insert a message with invalid JSON that happens to match the LIKE filter
    const msgId = `msg-malformed-${Date.now()}`;
    rawRun(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      msgId,
      convId,
      "assistant",
      'not valid json but has "type":"ui_surface" in it',
      Date.now(),
    );

    // Also insert a valid message referencing the app
    const convId2 = "conv-valid";
    insertConversation(convId2);
    insertMessage(convId2, [
      {
        type: "ui_surface",
        surfaceType: "dynamic_page",
        data: { appId: app.id, html: "<h1>App</h1>" },
      },
    ]);

    // Should not throw, and should still process the valid message
    backfillAppConversationIds();

    const loaded = getApp(app.id);
    expect(loaded?.conversationIds).toEqual([convId2]);
  });

  test("skips ui_surface blocks without data.appId", () => {
    const app = createApp(makeAppParams("No AppId App"));
    const convId = "conv-no-appid";
    insertConversation(convId);

    // ui_surface block without appId in data
    insertMessage(convId, [
      {
        type: "ui_surface",
        surfaceType: "card",
        data: { title: "Hello", body: "World" },
      },
    ]);

    backfillAppConversationIds();

    const loaded = getApp(app.id);
    expect(loaded?.conversationIds).toBeUndefined();
  });

  test("preserves existing conversationIds added before backfill", () => {
    const app = createApp(makeAppParams("Pre-existing App"));
    const existingConvId = "conv-existing";
    const backfillConvId = "conv-from-backfill";
    insertConversation(existingConvId);
    insertConversation(backfillConvId);

    // Manually add a conversationId before backfill
    addAppConversationId(app.id, existingConvId);

    // Insert a message referencing the app from a different conversation
    insertMessage(backfillConvId, [
      {
        type: "ui_surface",
        surfaceType: "dynamic_page",
        data: { appId: app.id, html: "<h1>App</h1>" },
      },
    ]);

    backfillAppConversationIds();

    const loaded = getApp(app.id);
    expect(loaded?.conversationIds).toEqual([existingConvId, backfillConvId]);
  });
});
