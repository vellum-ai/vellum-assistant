import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/secure-keys.js", () => ({
  getSecureKeyAsync: async () => undefined,
}));

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { llmUsageEvents } from "../persistence/schema/index.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { ROUTES } from "../runtime/routes/log-export-routes.js";
import { getLogsDir } from "../util/platform.js";

await initializeDb();

const exportRoute = ROUTES.find((r) => r.endpoint === "export")!;

function clearConnectedClients(): void {
  for (const client of assistantEventHub.listClients()) {
    assistantEventHub.disposeClient(client.clientId);
  }
}

beforeEach(() => {
  clearConnectedClients();
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

describe("POST /v1/export - conversation-scoped daemon logs", () => {
  test("retains the full daily assistant log even when lines are not tagged with the conversationId", async () => {
    /**
     * Tests that a conversation-scoped export keeps the full daily assistant
     * log so agent-loop failures logged without the conversationId stay
     * visible, while still emitting the conversation-filtered index.
     */

    // GIVEN a daily assistant log with a line that mentions the conversation
    // AND an agent-loop failure line that does NOT — the kind that
    // conversationId grepping would drop
    const conversationId = "conv-export-log-retention";
    const today = new Date().toISOString().slice(0, 10);
    const logsDir = getLogsDir();
    mkdirSync(logsDir, { recursive: true });
    const logFileName = `assistant-${today}.log`;
    const logPath = join(logsDir, logFileName);
    const taggedLine = `[agent] processing turn for ${conversationId}`;
    const untaggedErrorLine =
      "[agent] ERROR agent loop failed: stream aborted before first token";
    writeFileSync(logPath, `${taggedLine}\n${untaggedErrorLine}\n`, "utf-8");

    try {
      // WHEN we run a conversation-scoped export
      const result = await exportRoute.handler({ body: { conversationId } });

      // THEN the archive is produced
      expect(result).toBeInstanceOf(Uint8Array);

      const dir = await extractArchive(result as Uint8Array);
      try {
        // AND the full daily log is retained, including the untagged failure
        const exportedLogPath = join(dir, "daemon-logs", logFileName);
        expect(existsSync(exportedLogPath)).toBe(true);
        const exportedLog = readFileSync(exportedLogPath, "utf-8");
        expect(exportedLog).toContain(untaggedErrorLine);
        expect(exportedLog).toContain(taggedLine);

        // AND the conversation-filtered slice still exists as a quick index
        const filteredPath = join(
          dir,
          "daemon-logs",
          "conversation-filtered.jsonl",
        );
        expect(existsSync(filteredPath)).toBe(true);
        const filtered = readFileSync(filteredPath, "utf-8");
        expect(filtered).toContain(taggedLine);
        expect(filtered).not.toContain(untaggedErrorLine);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      rmSync(logPath, { force: true });
    }
  });
});

describe("POST /v1/export - LLM usage events", () => {
  test("full export includes usage attribution columns", async () => {
    const db = getDb();
    const eventId = "usage-attribution-export-test";
    db.delete(llmUsageEvents).run();
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
