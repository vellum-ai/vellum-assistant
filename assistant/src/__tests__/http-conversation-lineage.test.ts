import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "http-conversation-lineage-test-")),
);

mock.module("../util/platform.js", () => ({
  getRootDir: () => join(testDir, ".vellum"),
  getDataDir: () => join(testDir, ".vellum", "workspace", "data"),
  getWorkspaceDir: () => join(testDir, ".vellum", "workspace"),
  getConversationsDir: () =>
    join(testDir, ".vellum", "workspace", "conversations"),
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

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
  getGatewayPort: () => 7830,
  getRuntimeHttpPort: () => 7821,
  getRuntimeHttpHost: () => "127.0.0.1",
  getRuntimeGatewayOriginSecret: () => undefined,
  getIngressPublicBaseUrl: () => undefined,
  setIngressPublicBaseUrl: () => {},
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import {
  batchSetDisplayOrders,
  createConversation,
  updateConversationTitle,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb, rawRun, resetDb } from "../memory/db.js";
import { RuntimeHttpServer } from "../runtime/http-server.js";

initializeDb();

type ConversationSummary = {
  id: string;
  title: string;
  displayOrder?: number | null;
  isPinned?: boolean;
  forkParent?: {
    conversationId: string;
    messageId: string;
    title: string;
  };
};

describe("conversation lineage in HTTP reads", () => {
  let server: RuntimeHttpServer | null = null;

  beforeEach(async () => {
    await server?.stop();
    server = null;
    clearTables();
  });

  afterAll(async () => {
    await server?.stop();
    resetDb();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test("GET /v1/conversations returns forkParent for surviving parents", async () => {
    const { child, parent } = seedForkedConversation();
    await startServer();

    const response = await fetch(url("/conversations"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      conversations: ConversationSummary[];
      hasMore: boolean;
    };
    const listedChild = body.conversations.find((item) => item.id === child.id);

    expect(listedChild).toMatchObject({
      id: child.id,
      title: child.title ?? "Untitled",
      forkParent: {
        conversationId: parent.id,
        messageId: "parent-msg-1",
        title: parent.title ?? "Untitled",
      },
    });
    expect(body.hasMore).toBe(false);
  });

  test("GET /v1/conversations/:id returns forkParent for surviving parents", async () => {
    const { child, parent } = seedForkedConversation();
    await startServer();

    const response = await fetch(url(`/conversations/${child.id}`));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      conversation: ConversationSummary;
    };

    expect(body.conversation).toMatchObject({
      id: child.id,
      title: child.title ?? "Untitled",
      forkParent: {
        conversationId: parent.id,
        messageId: "parent-msg-1",
        title: parent.title ?? "Untitled",
      },
    });
  });

  test("GET /v1/conversations/:id includes pin metadata when present", async () => {
    const conversation = createConversation("Pinned conversation");
    batchSetDisplayOrders([
      { id: conversation.id, displayOrder: 7, isPinned: true },
    ]);
    await startServer();

    const response = await fetch(url(`/conversations/${conversation.id}`));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      conversation: ConversationSummary;
    };

    expect(body.conversation).toMatchObject({
      id: conversation.id,
      title: conversation.title ?? "Untitled",
      displayOrder: 7,
      isPinned: true,
    });
  });

  test("GET /v1/conversations/:id resolves the parent's current title at read time", async () => {
    const { child, parent } = seedForkedConversation({
      parentTitle: "Original parent title",
    });
    updateConversationTitle(parent.id, "Renamed parent title", 0);
    await startServer();

    const response = await fetch(url(`/conversations/${child.id}`));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      conversation: ConversationSummary;
    };

    expect(body.conversation.forkParent).toEqual({
      conversationId: parent.id,
      messageId: "parent-msg-1",
      title: "Renamed parent title",
    });
  });

  test("deleted parents are omitted from list and detail responses", async () => {
    const { child, parent } = seedForkedConversation();
    rawRun("DELETE FROM conversations WHERE id = ?", parent.id);
    await startServer();

    const listResponse = await fetch(url("/conversations"));
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as {
      conversations: ConversationSummary[];
    };
    const listedChild = listBody.conversations.find(
      (item) => item.id === child.id,
    );
    expect(listedChild).toBeDefined();
    expect(listedChild?.forkParent).toBeUndefined();

    const detailResponse = await fetch(url(`/conversations/${child.id}`));
    expect(detailResponse.status).toBe(200);
    const detailBody = (await detailResponse.json()) as {
      conversation: ConversationSummary;
    };
    expect(detailBody.conversation.forkParent).toBeUndefined();
  });

  function clearTables(): void {
    const db = getDb();
    db.run("DELETE FROM conversation_assistant_attention_state");
    db.run("DELETE FROM external_conversation_bindings");
    db.run("DELETE FROM conversation_keys");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  }

  function seedForkedConversation(opts?: { parentTitle?: string }) {
    const parent = createConversation(
      opts?.parentTitle ?? "Parent conversation",
    );
    const child = createConversation("Forked conversation");

    rawRun(
      `
        UPDATE conversations
        SET fork_parent_conversation_id = ?, fork_parent_message_id = ?
        WHERE id = ?
      `,
      parent.id,
      "parent-msg-1",
      child.id,
    );

    return { parent, child };
  }

  async function startServer(): Promise<void> {
    server = new RuntimeHttpServer({
      port: 0,
      bearerToken: "test-bearer-token",
    });
    await server.start();
  }

  function url(pathname: string): string {
    if (!server) throw new Error("server not started");
    return `http://127.0.0.1:${server.actualPort}/v1${pathname}`;
  }
});
