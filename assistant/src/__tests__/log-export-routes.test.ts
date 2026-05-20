import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../util/secure-keys.js", () => ({
  getSecureKeyAsync: async () => undefined,
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  conversations,
  llmRequestLogs,
  llmUsageEvents,
  messages,
} from "../memory/schema.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { ROUTES } from "../runtime/routes/log-export-routes.js";

initializeDb();

const exportRoute = ROUTES.find((r) => r.endpoint === "export")!;

function clearConnectedClients(): void {
  for (const client of assistantEventHub.listClients()) {
    assistantEventHub.disposeClient(client.clientId);
  }
}

beforeEach(() => {
  clearConnectedClients();

  const db = getDb();
  db.delete(llmUsageEvents).run();
  db.delete(llmRequestLogs).run();
  db.delete(messages).run();
  db.delete(conversations).run();
});

async function extractArchive(bytes: Uint8Array): Promise<string> {
  const extractDir = mkdtempSync(join(tmpdir(), "log-export-routes-"));
  const archivePath = join(extractDir, "archive.tar.gz");
  writeFileSync(archivePath, bytes);

  const proc = spawnSync("tar", ["xzf", archivePath, "-C", extractDir]);
  if (proc.status !== 0) {
    throw new Error(
      `tar extraction failed: ${proc.stderr?.toString() ?? "unknown error"}`,
    );
  }

  return extractDir;
}

describe("POST /v1/export - connected clients", () => {
  test("includes current `assistant clients list --json` output", async () => {
    const subscription = assistantEventHub.subscribe({
      type: "client",
      clientId: "client-list-export-test",
      interfaceId: "macos",
      capabilities: ["host_bash", "host_file"],
      machineName: "test-macbook",
      callback: () => {},
    });

    try {
      const result = await exportRoute.handler({ body: {} });
      expect(result).toBeInstanceOf(Uint8Array);

      const dir = await extractArchive(result as Uint8Array);
      try {
        const clientsList = JSON.parse(
          readFileSync(join(dir, "clients-list.json"), "utf-8"),
        ) as {
          clients: Array<{
            clientId: string;
            interfaceId: string;
            capabilities: string[];
            machineName?: string;
            connectedAt: string;
            lastActiveAt: string;
          }>;
        };

        expect(clientsList.clients).toHaveLength(1);
        expect(clientsList.clients[0]).toMatchObject({
          clientId: "client-list-export-test",
          interfaceId: "macos",
          capabilities: ["host_bash", "host_file"],
          machineName: "test-macbook",
        });
        expect(new Date(clientsList.clients[0].connectedAt).toISOString()).toBe(
          clientsList.clients[0].connectedAt,
        );
        expect(
          new Date(clientsList.clients[0].lastActiveAt).toISOString(),
        ).toBe(clientsList.clients[0].lastActiveAt);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      subscription.dispose();
    }
  });

  test("writes a non-blocking error artifact when client listing fails", async () => {
    const originalListClients = assistantEventHub.listClients;
    assistantEventHub.listClients = () => {
      throw new Error("client list unavailable");
    };

    try {
      const result = await exportRoute.handler({ body: {} });
      expect(result).toBeInstanceOf(Uint8Array);

      const dir = await extractArchive(result as Uint8Array);
      try {
        expect(existsSync(join(dir, "clients-list.json"))).toBe(false);
        const errorArtifact = JSON.parse(
          readFileSync(join(dir, "clients-list-error.json"), "utf-8"),
        ) as { error: string; collectedAt: string };
        expect(errorArtifact.error).toBe("client list unavailable");
        expect(new Date(errorArtifact.collectedAt).toISOString()).toBe(
          errorArtifact.collectedAt,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      assistantEventHub.listClients = originalListClients;
    }
  });
});

describe("POST /v1/export - LLM usage events", () => {
  test("full export includes usage attribution columns", async () => {
    const db = getDb();
    const eventId = "usage-attribution-export-test";
    db.insert(llmUsageEvents)
      .values({
        id: eventId,
        createdAt: 1700000000000,
        conversationId: "conv-export-attribution",
        runId: null,
        requestId: null,
        actor: "llm_call_site",
        callSite: "conversationTitle",
        inferenceProfile: "balanced",
        inferenceProfileSource: "active",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        inputTokens: 12,
        outputTokens: 7,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        estimatedCostUsd: 0.0001,
        pricingStatus: "priced",
        llmCallCount: 1,
        metadataJson: null,
      })
      .run();

    const result = await exportRoute.handler({ body: { full: true } });
    expect(result).toBeInstanceOf(Uint8Array);

    const dir = await extractArchive(result as Uint8Array);
    try {
      const rows = JSON.parse(
        readFileSync(join(dir, "llm-usage-events.json"), "utf-8"),
      ) as Array<Record<string, unknown>>;
      const row = rows.find((candidate) => candidate.id === eventId);
      expect(row).toMatchObject({
        callSite: "conversationTitle",
        inferenceProfile: "balanced",
        inferenceProfileSource: "active",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("POST /v1/export - conversation scoping", () => {
  test("exports conversation rows, messages, and LLM request logs for a conversation id", async () => {
    const db = getDb();
    const selectedConversationId = "slack-thread:C123:1700000000.000000";
    const otherConversationId = "conv-other-internal";

    db.insert(conversations)
      .values([
        {
          id: selectedConversationId,
          title: "Selected conversation",
          createdAt: 1700000000000,
          updatedAt: 1700000001000,
        },
        {
          id: otherConversationId,
          title: "Other conversation",
          createdAt: 1700000002000,
          updatedAt: 1700000003000,
        },
      ])
      .run();

    db.insert(messages)
      .values([
        {
          id: "message-selected",
          conversationId: selectedConversationId,
          role: "user",
          content: "selected message",
          createdAt: 1700000000100,
        },
        {
          id: "message-other",
          conversationId: otherConversationId,
          role: "user",
          content: "other message",
          createdAt: 1700000000200,
        },
      ])
      .run();

    db.insert(llmRequestLogs)
      .values([
        {
          id: "llm-log-selected",
          conversationId: selectedConversationId,
          messageId: "message-selected",
          provider: "anthropic",
          requestPayload: JSON.stringify({ prompt: "selected" }),
          responsePayload: JSON.stringify({ text: "selected response" }),
          createdAt: 1700000000300,
          agentLoopExitReason: "final_message",
        },
        {
          id: "llm-log-other",
          conversationId: otherConversationId,
          messageId: "message-other",
          provider: "anthropic",
          requestPayload: JSON.stringify({ prompt: "other" }),
          responsePayload: JSON.stringify({ text: "other response" }),
          createdAt: 1700000000400,
          agentLoopExitReason: "final_message",
        },
      ])
      .run();

    const result = await exportRoute.handler({
      body: { conversationId: selectedConversationId },
    });
    expect(result).toBeInstanceOf(Uint8Array);

    const dir = await extractArchive(result as Uint8Array);
    try {
      const conversationRows = JSON.parse(
        readFileSync(join(dir, "conversations.json"), "utf-8"),
      ) as Array<Record<string, unknown>>;
      expect(conversationRows.map((row) => row.id)).toEqual([
        selectedConversationId,
      ]);

      const messageRows = JSON.parse(
        readFileSync(join(dir, "messages.json"), "utf-8"),
      ) as Array<Record<string, unknown>>;
      expect(messageRows.map((row) => row.id)).toEqual(["message-selected"]);

      const requestLogRows = JSON.parse(
        readFileSync(join(dir, "llm-request-logs.json"), "utf-8"),
      ) as Array<Record<string, unknown>>;
      expect(requestLogRows.map((row) => row.id)).toEqual(["llm-log-selected"]);

      const manifest = JSON.parse(
        readFileSync(join(dir, "export-manifest.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        type: "conversation-export",
        conversationId: selectedConversationId,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
