/**
 * Tests for the diagnostics export route handler.
 *
 * Validates anchor message resolution, including the fallback chain
 * (specific ID → most recent assistant → any message → empty conversation).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import JSZip from "jszip";

const testDir = mkdtempSync(join(tmpdir(), "diagnostics-export-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getSqlite, initializeDb, resetDb } from "../memory/db.js";
import { diagnosticsRouteDefinitions } from "../runtime/routes/diagnostics-routes.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const routes = diagnosticsRouteDefinitions();
const exportRoute = routes.find((r) => r.endpoint === "diagnostics/export")!;

async function callExport(body: Record<string, unknown>): Promise<Response> {
  const req = new Request("http://localhost/v1/diagnostics/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const url = new URL(req.url);
  return exportRoute.handler({
    req,
    url,
    server: null as never,
    authContext: {} as never,
    params: {},
  });
}

const db = () => getSqlite();

function seedConversation(id: string): void {
  const now = Date.now();
  db().run(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [id, "Test", now, now],
  );
}

function seedMessage(
  id: string,
  conversationId: string,
  role: string,
  content: string,
  createdAt: number,
): void {
  db().run(
    "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    [id, conversationId, role, content, createdAt],
  );
}

function seedLlmRequestLog(
  id: string,
  conversationId: string,
  provider: string | null,
  requestPayload: unknown,
  responsePayload: unknown,
  createdAt: number,
): void {
  db().run(
    "INSERT INTO llm_request_logs (id, conversation_id, provider, request_payload, response_payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      id,
      conversationId,
      provider,
      JSON.stringify(requestPayload),
      JSON.stringify(responsePayload),
      createdAt,
    ],
  );
}

function seedConversationKey(
  conversationKey: string,
  conversationId: string,
): void {
  db().run(
    "INSERT INTO conversation_keys (id, conversation_key, conversation_id, created_at) VALUES (?, ?, ?, ?)",
    [crypto.randomUUID(), conversationKey, conversationId, Date.now()],
  );
}

function cleanDb(): void {
  db().run("DELETE FROM messages");
  db().run("DELETE FROM llm_request_logs");
  db().run("DELETE FROM conversation_keys");
  db().run("DELETE FROM conversations");
}

beforeEach(() => {
  cleanDb();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("diagnostics export", () => {
  test("returns 400 when conversationId is missing", async () => {
    const res = await callExport({});
    expect(res.status).toBe(400);
  });

  test("succeeds with specific anchorMessageId", async () => {
    const convId = "conv-1";
    const msgId = "msg-assistant-1";
    const now = Date.now();

    seedConversation(convId);
    seedMessage("msg-user-1", convId, "user", "hello", now - 1000);
    seedMessage(msgId, convId, "assistant", "world", now);

    const res = await callExport({
      conversationId: convId,
      anchorMessageId: msgId,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; filePath: string };
    expect(json.success).toBe(true);
    expect(json.filePath).toContain("diagnostics-");
  });

  test("falls back to most recent assistant message when anchorMessageId is omitted", async () => {
    const convId = "conv-2";
    const now = Date.now();

    seedConversation(convId);
    seedMessage("msg-user-1", convId, "user", "hello", now - 1000);
    seedMessage("msg-assistant-1", convId, "assistant", "world", now);

    const res = await callExport({ conversationId: convId });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
  });

  test("falls back to any message when no assistant messages exist (race condition fix)", async () => {
    const convId = "conv-3";
    const now = Date.now();

    seedConversation(convId);
    // Only a user message — assistant response hasn't been persisted yet
    seedMessage("msg-user-1", convId, "user", "hello", now);

    const res = await callExport({ conversationId: convId });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; filePath: string };
    expect(json.success).toBe(true);
    expect(json.filePath).toContain("diagnostics-");
  });

  test("succeeds with empty conversation (no messages at all)", async () => {
    const convId = "conv-4";

    seedConversation(convId);
    // No messages at all — conversation was just created

    const res = await callExport({ conversationId: convId });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; filePath: string };
    expect(json.success).toBe(true);
    expect(json.filePath).toContain("diagnostics-");
  });

  test("resolves conversation key to daemon conversation ID", async () => {
    const daemonConvId = "conv-6-daemon";
    const clientKey = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const now = Date.now();

    seedConversation(daemonConvId);
    seedConversationKey(clientKey, daemonConvId);
    seedMessage("msg-user-6", daemonConvId, "user", "hello", now - 1000);
    seedMessage("msg-assistant-6", daemonConvId, "assistant", "world", now);

    // Client sends the conversation key (client-side UUID), not the daemon ID
    const res = await callExport({ conversationId: clientKey });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; filePath: string };
    expect(json.success).toBe(true);
    // The export should find the messages via the resolved daemon ID
    expect(json.filePath).toContain("diagnostics-");
  });

  test("falls back to any-message when anchorMessageId is provided but not found", async () => {
    const convId = "conv-5";
    const now = Date.now();

    seedConversation(convId);
    seedMessage("msg-user-1", convId, "user", "hello", now);

    // anchorMessageId doesn't exist — should fall through all the way
    const res = await callExport({
      conversationId: convId,
      anchorMessageId: "nonexistent-msg-id",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
  });

  test("preserves llm request provider identity in the exported JSONL", async () => {
    const convId = "conv-7";
    const now = Date.now();

    seedConversation(convId);
    seedMessage("msg-user-7", convId, "user", "hello", now - 1000);
    seedMessage("msg-assistant-7", convId, "assistant", "world", now);
    seedLlmRequestLog(
      "log-7",
      convId,
      "openrouter",
      { model: "openai/gpt-4.1-mini", input: "hello" },
      { output: "world" },
      now,
    );

    const res = await callExport({ conversationId: convId });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; filePath: string };
    expect(json.success).toBe(true);

    const zip = await JSZip.loadAsync(readFileSync(json.filePath));
    const llmRequests = zip.file("llm_requests.jsonl");
    expect(llmRequests).not.toBeNull();

    const lines = (await llmRequests!.async("string")).trim().split("\n");
    expect(lines).toHaveLength(1);

    const row = JSON.parse(lines[0]) as {
      id: string;
      conversationId: string;
      provider?: string | null;
      request: unknown;
      response: unknown;
    };

    expect(row).toMatchObject({
      id: "log-7",
      conversationId: convId,
      provider: "openrouter",
    });

    rmSync(json.filePath, { force: true });
  });
});
