import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// Use an isolated temp directory so tests don't touch the real workspace config.
const testDir = join(
  tmpdir(),
  `vellum-privacy-test-${randomBytes(6).toString("hex")}`,
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

const { createPrivacyConfigGetHandler } =
  await import("../http/routes/privacy-config.js");

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
