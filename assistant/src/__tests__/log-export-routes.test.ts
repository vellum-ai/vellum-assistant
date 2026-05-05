import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

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
import { llmUsageEvents } from "../memory/schema.js";
import { ROUTES } from "../runtime/routes/log-export-routes.js";

initializeDb();

const exportRoute = ROUTES.find((r) => r.endpoint === "export")!;

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
