import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// Use an isolated temp directory so tests don't touch the real workspace config.
const testDir = join(
  tmpdir(),
  `vellum-privacy-config-test-${randomBytes(6).toString("hex")}`,
);
const vellumRoot = join(testDir, ".vellum");
const workspaceDir = join(vellumRoot, "workspace");
const configPath = join(workspaceDir, "config.json");

const savedBaseDataDir = process.env.BASE_DATA_DIR;
const savedWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;

beforeEach(() => {
  process.env.BASE_DATA_DIR = testDir;
  // Ensure we do not inherit a VELLUM_WORKSPACE_DIR override from the test runner;
  // we want config.json to resolve under testDir/.vellum/workspace.
  delete process.env.VELLUM_WORKSPACE_DIR;
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (savedBaseDataDir === undefined) {
    delete process.env.BASE_DATA_DIR;
  } else {
    process.env.BASE_DATA_DIR = savedBaseDataDir;
  }
  if (savedWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = savedWorkspaceDir;
  }
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
});

const { createPrivacyConfigPatchHandler, createPrivacyConfigGetHandler } =
  await import("../http/routes/privacy-config.js");

function makePatch(body: unknown): Request {
  return new Request("http://gateway.test/v1/config/privacy", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function readConfig(): Record<string, unknown> {
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw);
}

// The default value for memory.cleanup.llmRequestLogRetentionMs in the
// daemon schema (assistant/src/config/schemas/memory-lifecycle.ts): 1 day.
const DEFAULT_RETENTION_MS = 1 * 24 * 60 * 60 * 1000;

describe("GET /v1/config/privacy handler", () => {
  test("returns schema defaults when config.json does not exist", async () => {
    if (existsSync(configPath)) {
      rmSync(configPath);
    }

    const handler = createPrivacyConfigGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/config/privacy"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      collectUsageData: true,
      sendDiagnostics: true,
      llmRequestLogRetentionMs: DEFAULT_RETENTION_MS,
    });
    // Sanity check: 1 day in ms.
    expect(body.llmRequestLogRetentionMs).toBe(86_400_000);
  });

  test("returns explicit values from config.json", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        collectUsageData: false,
        sendDiagnostics: false,
        memory: {
          cleanup: {
            llmRequestLogRetentionMs: 3 * 24 * 60 * 60 * 1000,
          },
        },
      }),
    );

    const handler = createPrivacyConfigGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/config/privacy"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      collectUsageData: false,
      sendDiagnostics: false,
      llmRequestLogRetentionMs: 3 * 24 * 60 * 60 * 1000,
    });
  });

  test("falls back to default when llmRequestLogRetentionMs is a string", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        collectUsageData: true,
        sendDiagnostics: true,
        memory: {
          cleanup: {
            llmRequestLogRetentionMs: "not-a-number",
          },
        },
      }),
    );

    const handler = createPrivacyConfigGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/config/privacy"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llmRequestLogRetentionMs).toBe(DEFAULT_RETENTION_MS);
  });

  test("returns 0 verbatim when llmRequestLogRetentionMs is 0 (never prune)", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        memory: {
          cleanup: {
            llmRequestLogRetentionMs: 0,
          },
        },
      }),
    );

    const handler = createPrivacyConfigGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/config/privacy"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llmRequestLogRetentionMs).toBe(0);
    // Other fields fall back to their schema defaults.
    expect(body.collectUsageData).toBe(true);
    expect(body.sendDiagnostics).toBe(true);
  });

  test("falls back to defaults when collectUsageData/sendDiagnostics are non-boolean", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        collectUsageData: "yes",
        sendDiagnostics: 1,
      }),
    );

    const handler = createPrivacyConfigGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/config/privacy"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.collectUsageData).toBe(true);
    expect(body.sendDiagnostics).toBe(true);
  });

  test("falls back to default when llmRequestLogRetentionMs is a negative number", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        memory: {
          cleanup: {
            llmRequestLogRetentionMs: -100,
          },
        },
      }),
    );

    const handler = createPrivacyConfigGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/config/privacy"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llmRequestLogRetentionMs).toBe(DEFAULT_RETENTION_MS);
  });

  test("falls back to default when llmRequestLogRetentionMs is a non-integer number", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        memory: {
          cleanup: {
            llmRequestLogRetentionMs: 1.5,
          },
        },
      }),
    );

    const handler = createPrivacyConfigGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/config/privacy"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llmRequestLogRetentionMs).toBe(DEFAULT_RETENTION_MS);
  });

  test("falls back to default when memory.cleanup is missing entirely", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        collectUsageData: false,
      }),
    );

    const handler = createPrivacyConfigGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/config/privacy"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      collectUsageData: false,
      sendDiagnostics: true,
      llmRequestLogRetentionMs: DEFAULT_RETENTION_MS,
    });
  });

  test("returns 500 when config.json is malformed JSON", async () => {
    writeFileSync(configPath, "{not valid json");

    const handler = createPrivacyConfigGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/config/privacy"),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Config file is malformed");
  });

  test("returns 500 when config.json is an array (not an object)", async () => {
    writeFileSync(configPath, JSON.stringify([1, 2, 3]));

    const handler = createPrivacyConfigGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/config/privacy"),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Config file is malformed");
  });

  test("handles assistant-scoped path (no trailing slash stripping needed)", async () => {
    // The assistant-scoped route uses a regex that matches the trailing
    // slash variant; handler logic itself does not care about the URL.
    writeFileSync(
      configPath,
      JSON.stringify({
        collectUsageData: false,
        sendDiagnostics: false,
      }),
    );

    const handler = createPrivacyConfigGetHandler();
    const res = await handler(
      new Request(
        "http://gateway.test/v1/assistants/some-assistant-id/config/privacy/",
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.collectUsageData).toBe(false);
    expect(body.sendDiagnostics).toBe(false);
    expect(body.llmRequestLogRetentionMs).toBe(DEFAULT_RETENTION_MS);
  });
});

describe("PATCH /v1/config/privacy handler — llmRequestLogRetentionMs", () => {
  test("persists llmRequestLogRetentionMs: 0 (never prune) to memory.cleanup.llmRequestLogRetentionMs", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ llmRequestLogRetentionMs: 0 }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llmRequestLogRetentionMs).toBe(0);

    expect(existsSync(configPath)).toBe(true);
    const config = readConfig();
    expect(config.memory).toBeDefined();
    expect((config.memory as Record<string, unknown>).cleanup).toBeDefined();
    const cleanup = (config.memory as Record<string, unknown>)
      .cleanup as Record<string, unknown>;
    expect(cleanup.llmRequestLogRetentionMs).toBe(0);
  });

  test("persists llmRequestLogRetentionMs: 86400000 (1 day)", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const oneDayMs = 86_400_000;
    const res = await handler(
      makePatch({ llmRequestLogRetentionMs: oneDayMs }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llmRequestLogRetentionMs).toBe(oneDayMs);

    const config = readConfig();
    const cleanup = (config.memory as Record<string, unknown>)
      .cleanup as Record<string, unknown>;
    expect(cleanup.llmRequestLogRetentionMs).toBe(oneDayMs);
  });

  test("accepts the upper bound (365 days in ms)", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const max = 365 * 24 * 60 * 60 * 1000;
    const res = await handler(makePatch({ llmRequestLogRetentionMs: max }));

    expect(res.status).toBe(200);
    const config = readConfig();
    const cleanup = (config.memory as Record<string, unknown>)
      .cleanup as Record<string, unknown>;
    expect(cleanup.llmRequestLogRetentionMs).toBe(max);
  });

  test("mixed payload: collectUsageData + llmRequestLogRetentionMs updates both without clobbering", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(
      makePatch({
        collectUsageData: true,
        llmRequestLogRetentionMs: 3_600_000,
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.collectUsageData).toBe(true);
    expect(body.llmRequestLogRetentionMs).toBe(3_600_000);

    const config = readConfig();
    expect(config.collectUsageData).toBe(true);
    const cleanup = (config.memory as Record<string, unknown>)
      .cleanup as Record<string, unknown>;
    expect(cleanup.llmRequestLogRetentionMs).toBe(3_600_000);
  });

  test("mixed payload: sendDiagnostics + llmRequestLogRetentionMs updates both", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(
      makePatch({
        sendDiagnostics: false,
        llmRequestLogRetentionMs: 7_200_000,
      }),
    );

    expect(res.status).toBe(200);
    const config = readConfig();
    expect(config.sendDiagnostics).toBe(false);
    const cleanup = (config.memory as Record<string, unknown>)
      .cleanup as Record<string, unknown>;
    expect(cleanup.llmRequestLogRetentionMs).toBe(7_200_000);
  });

  test("preserves pre-existing unrelated nested keys under memory.*", async () => {
    // Pre-seed a config with an unrelated nested key under memory
    const preExisting = {
      collectUsageData: false,
      memory: {
        segmentation: {
          targetTokens: 2000,
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(preExisting, null, 2));

    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(
      makePatch({ llmRequestLogRetentionMs: 86_400_000 }),
    );

    expect(res.status).toBe(200);
    const config = readConfig();

    // Previous top-level key preserved
    expect(config.collectUsageData).toBe(false);

    // Previous nested memory.segmentation preserved
    const memory = config.memory as Record<string, unknown>;
    expect(memory.segmentation).toBeDefined();
    const segmentation = memory.segmentation as Record<string, unknown>;
    expect(segmentation.targetTokens).toBe(2000);

    // New cleanup value added
    const cleanup = memory.cleanup as Record<string, unknown>;
    expect(cleanup.llmRequestLogRetentionMs).toBe(86_400_000);
  });

  test("preserves pre-existing memory.cleanup sibling keys when updating llmRequestLogRetentionMs", async () => {
    const preExisting = {
      memory: {
        cleanup: {
          someOtherCleanupKey: "value",
          llmRequestLogRetentionMs: 1000,
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(preExisting, null, 2));

    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ llmRequestLogRetentionMs: 5000 }));

    expect(res.status).toBe(200);
    const config = readConfig();
    const memory = config.memory as Record<string, unknown>;
    const cleanup = memory.cleanup as Record<string, unknown>;
    expect(cleanup.someOtherCleanupKey).toBe("value");
    expect(cleanup.llmRequestLogRetentionMs).toBe(5000);
  });

  test("rejects llmRequestLogRetentionMs: -1 with 400", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ llmRequestLogRetentionMs: -1 }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("llmRequestLogRetentionMs");
  });

  test("rejects llmRequestLogRetentionMs above 365 days with 400", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const tooBig = 365 * 24 * 60 * 60 * 1000 + 1;
    const res = await handler(makePatch({ llmRequestLogRetentionMs: tooBig }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("llmRequestLogRetentionMs");
  });

  test("rejects llmRequestLogRetentionMs: 'not-a-number' with 400", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(
      makePatch({ llmRequestLogRetentionMs: "not-a-number" }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("llmRequestLogRetentionMs");
  });

  test("rejects non-integer llmRequestLogRetentionMs: 3.14 with 400", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ llmRequestLogRetentionMs: 3.14 }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("llmRequestLogRetentionMs");
  });

  test("rejects NaN and Infinity with 400", async () => {
    const handler = createPrivacyConfigPatchHandler();

    const res1 = await handler(
      makePatch({ llmRequestLogRetentionMs: Number.NaN }),
    );
    expect(res1.status).toBe(400);

    const res2 = await handler(
      makePatch({ llmRequestLogRetentionMs: Number.POSITIVE_INFINITY }),
    );
    expect(res2.status).toBe(400);
  });

  test("when only llmRequestLogRetentionMs is provided, existing collectUsageData/sendDiagnostics are unchanged", async () => {
    const preExisting = {
      collectUsageData: true,
      sendDiagnostics: true,
    };
    writeFileSync(configPath, JSON.stringify(preExisting, null, 2));

    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ llmRequestLogRetentionMs: 60_000 }));

    expect(res.status).toBe(200);
    const config = readConfig();
    expect(config.collectUsageData).toBe(true);
    expect(config.sendDiagnostics).toBe(true);
    const cleanup = (config.memory as Record<string, unknown>)
      .cleanup as Record<string, unknown>;
    expect(cleanup.llmRequestLogRetentionMs).toBe(60_000);
  });
});

describe("PATCH /v1/config/privacy handler — existing behavior (regression guard)", () => {
  test("PATCH with only collectUsageData still works", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ collectUsageData: true }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.collectUsageData).toBe(true);
    expect(body.llmRequestLogRetentionMs).toBeUndefined();

    const config = readConfig();
    expect(config.collectUsageData).toBe(true);
  });

  test("PATCH with only sendDiagnostics still works", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ sendDiagnostics: false }));

    expect(res.status).toBe(200);
    const config = readConfig();
    expect(config.sendDiagnostics).toBe(false);
  });

  test("PATCH with both booleans still works", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(
      makePatch({ collectUsageData: false, sendDiagnostics: true }),
    );

    expect(res.status).toBe(200);
    const config = readConfig();
    expect(config.collectUsageData).toBe(false);
    expect(config.sendDiagnostics).toBe(true);
  });

  test("PATCH with empty body still returns 400", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("llmRequestLogRetentionMs");
  });

  test("PATCH with invalid JSON still returns 400", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/config/privacy", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("valid JSON");
  });

  test("PATCH with non-boolean collectUsageData still returns 400", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ collectUsageData: "yes" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("collectUsageData");
  });

  test("PATCH with non-boolean sendDiagnostics still returns 400", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ sendDiagnostics: 1 }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("sendDiagnostics");
  });
});
