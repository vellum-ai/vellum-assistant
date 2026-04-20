import { describe, test, expect, afterEach } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { testWorkspaceDir } from "./test-preload.js";

const configPath = join(testWorkspaceDir, "config.json");

afterEach(() => {
  try {
    if (existsSync(configPath)) unlinkSync(configPath);
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
// daemon schema (assistant/src/config/schemas/memory-lifecycle.ts): 1 hour.
const DEFAULT_RETENTION_MS = 1 * 60 * 60 * 1000;

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
    // Sanity check: 1 hour in ms.
    expect(body.llmRequestLogRetentionMs).toBe(3_600_000);
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

  test("returns 0 verbatim when llmRequestLogRetentionMs is 0 (prune immediately)", async () => {
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
  test("returns null when config has llmRequestLogRetentionMs: null (keep forever)", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        memory: {
          cleanup: {
            llmRequestLogRetentionMs: null,
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
    expect(body.llmRequestLogRetentionMs).toBeNull();
    expect(body.collectUsageData).toBe(true);
    expect(body.sendDiagnostics).toBe(true);
  });
});

describe("PATCH /v1/config/privacy handler — llmRequestLogRetentionMs", () => {
  test("persists llmRequestLogRetentionMs: 0 (prune immediately) to memory.cleanup.llmRequestLogRetentionMs", async () => {
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

  test("NaN and Infinity serialize to null in JSON, which is now accepted as 'keep forever'", async () => {
    // JSON.stringify(NaN) = "null" and JSON.stringify(Infinity) = "null",
    // so these values are received as null by the handler. Under the new
    // semantics null is a valid value meaning "keep forever".
    const handler = createPrivacyConfigPatchHandler();

    const res1 = await handler(
      makePatch({ llmRequestLogRetentionMs: Number.NaN }),
    );
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.llmRequestLogRetentionMs).toBeNull();

    const res2 = await handler(
      makePatch({ llmRequestLogRetentionMs: Number.POSITIVE_INFINITY }),
    );
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.llmRequestLogRetentionMs).toBeNull();
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
  test("persists llmRequestLogRetentionMs: null (keep forever) and returns null in response", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ llmRequestLogRetentionMs: null }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llmRequestLogRetentionMs).toBeNull();

    expect(existsSync(configPath)).toBe(true);
    const config = readConfig();
    const cleanup = (config.memory as Record<string, unknown>)
      .cleanup as Record<string, unknown>;
    expect(cleanup.llmRequestLogRetentionMs).toBeNull();
  });

  test("PATCH null then GET returns null", async () => {
    const patchHandler = createPrivacyConfigPatchHandler();
    const patchRes = await patchHandler(
      makePatch({ llmRequestLogRetentionMs: null }),
    );
    expect(patchRes.status).toBe(200);

    const getHandler = createPrivacyConfigGetHandler();
    const getRes = await getHandler(
      new Request("http://gateway.test/v1/config/privacy"),
    );
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.llmRequestLogRetentionMs).toBeNull();
  });
});

describe("PATCH /v1/config/privacy handler — existing behavior (regression guard)", () => {
  test("PATCH with only collectUsageData still works and response includes default llmRequestLogRetentionMs", async () => {
    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ collectUsageData: true }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.collectUsageData).toBe(true);
    // Gap B fix: the PATCH response shape is unified with GET — the
    // `llmRequestLogRetentionMs` field is ALWAYS included, sourced from the
    // post-write config with a fallback to the daemon schema default. The
    // pre-existing config.json in this test has no retention value, so the
    // response should return the daemon default (1 day in ms).
    expect(body.llmRequestLogRetentionMs).toBe(DEFAULT_RETENTION_MS);

    const config = readConfig();
    expect(config.collectUsageData).toBe(true);
    // We did NOT pass llmRequestLogRetentionMs in the PATCH body, so no
    // memory.cleanup entry should have been written.
    expect(config.memory).toBeUndefined();
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
    const body = await res.json();
    // Gap B: PATCH response always includes llmRequestLogRetentionMs.
    expect(body.llmRequestLogRetentionMs).toBe(DEFAULT_RETENTION_MS);

    const config = readConfig();
    expect(config.collectUsageData).toBe(false);
    expect(config.sendDiagnostics).toBe(true);
  });

  test("PATCH with only booleans echoes pre-existing llmRequestLogRetentionMs from config.json", async () => {
    // Pre-seed a config that already has a non-default retention value.
    const preExistingRetention = 3 * 24 * 60 * 60 * 1000; // 3 days
    writeFileSync(
      configPath,
      JSON.stringify({
        collectUsageData: true,
        sendDiagnostics: true,
        memory: {
          cleanup: {
            llmRequestLogRetentionMs: preExistingRetention,
          },
        },
      }),
    );

    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ collectUsageData: false }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.collectUsageData).toBe(false);
    expect(body.sendDiagnostics).toBe(true);
    // Gap B: the response echoes the post-write retention value, even when
    // the PATCH body did not touch it.
    expect(body.llmRequestLogRetentionMs).toBe(preExistingRetention);

    // Config on disk must not lose the pre-existing retention value.
    const config = readConfig();
    const cleanup = (config.memory as Record<string, unknown>)
      .cleanup as Record<string, unknown>;
    expect(cleanup.llmRequestLogRetentionMs).toBe(preExistingRetention);
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

// Gap 2a-1: the PATCH response must always include collectUsageData and
// sendDiagnostics — even when config.json lacks the keys — because the
// OpenAPI schema marks both as `required`. Previously the PATCH handler read
// the booleans directly from the post-write config, producing `undefined`
// values that Response.json() silently drops. These regression tests fix the
// on-disk config to be "empty" before the PATCH and assert the response
// still has both booleans populated from defaults.
describe("PATCH /v1/config/privacy handler — Gap 2a-1 boolean defaults in response", () => {
  test("PATCH with only llmRequestLogRetentionMs returns both booleans as defaults when config.json lacks them", async () => {
    // Empty config.json — no collectUsageData, no sendDiagnostics.
    writeFileSync(configPath, JSON.stringify({}));

    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ llmRequestLogRetentionMs: 60_000 }));

    expect(res.status).toBe(200);
    const body = await res.json();
    // The schema contract: these fields are always present in the response.
    expect(body).toHaveProperty("collectUsageData");
    expect(body).toHaveProperty("sendDiagnostics");
    expect(body).toHaveProperty("llmRequestLogRetentionMs");
    expect(body.collectUsageData).toBe(true);
    expect(body.sendDiagnostics).toBe(true);
    expect(body.llmRequestLogRetentionMs).toBe(60_000);
  });

  test("PATCH with only collectUsageData returns sendDiagnostics as default when config.json lacks it", async () => {
    writeFileSync(configPath, JSON.stringify({}));

    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ collectUsageData: false }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.collectUsageData).toBe(false);
    // Default from daemon schema.
    expect(body.sendDiagnostics).toBe(true);
    // Default from daemon schema when memory.cleanup is missing.
    expect(body.llmRequestLogRetentionMs).toBe(DEFAULT_RETENTION_MS);
  });

  test("PATCH with only sendDiagnostics returns collectUsageData as default when config.json lacks it", async () => {
    writeFileSync(configPath, JSON.stringify({}));

    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ sendDiagnostics: false }));

    expect(res.status).toBe(200);
    const body = await res.json();
    // Default from daemon schema.
    expect(body.collectUsageData).toBe(true);
    expect(body.sendDiagnostics).toBe(false);
  });

  test("PATCH with only llmRequestLogRetentionMs returns default booleans when config.json has non-boolean values", async () => {
    // A user (or an older version of the code) wrote garbage into the
    // booleans. We should still respond with valid booleans so the UI
    // doesn't choke on a missing field.
    writeFileSync(
      configPath,
      JSON.stringify({
        collectUsageData: "yes",
        sendDiagnostics: 1,
      }),
    );

    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ llmRequestLogRetentionMs: 60_000 }));

    expect(res.status).toBe(200);
    const body = await res.json();
    // Fall back to schema defaults.
    expect(body.collectUsageData).toBe(true);
    expect(body.sendDiagnostics).toBe(true);
    expect(body.llmRequestLogRetentionMs).toBe(60_000);
  });
});

// Gap 2a-2: parseNestedNumber must clamp values above
// MAX_LLM_REQUEST_LOG_RETENTION_MS (365 days). A manually-edited config.json
// containing a 10-year retention (or any bogus large number) would otherwise
// be served verbatim from GET, and the Swift UI's `closest(toMs:)` would
// snap it to the nearest supported option, and the next PATCH would silently
// truncate the on-disk value — data loss with no UI warning.
describe("GET /v1/config/privacy handler — Gap 2a-2 out-of-range clamp", () => {
  test("clamps llmRequestLogRetentionMs above 365 days to the default on GET", async () => {
    const tooBig = 365 * 24 * 60 * 60 * 1000 + 1; // 1ms over max
    writeFileSync(
      configPath,
      JSON.stringify({
        memory: {
          cleanup: {
            llmRequestLogRetentionMs: tooBig,
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
    // Clamped to default, not the bogus value on disk.
    expect(body.llmRequestLogRetentionMs).toBe(DEFAULT_RETENTION_MS);
    expect(body.llmRequestLogRetentionMs).toBe(3_600_000);
  });

  test("clamps a 10-year retention (e.g. 315360000000) to the default on GET", async () => {
    const tenYearsMs = 10 * 365 * 24 * 60 * 60 * 1000;
    writeFileSync(
      configPath,
      JSON.stringify({
        memory: {
          cleanup: {
            llmRequestLogRetentionMs: tenYearsMs,
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

  test("does NOT clamp the exact 365-day boundary", async () => {
    const maxMs = 365 * 24 * 60 * 60 * 1000;
    writeFileSync(
      configPath,
      JSON.stringify({
        memory: {
          cleanup: {
            llmRequestLogRetentionMs: maxMs,
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
    // 365 days exactly is still valid — only values ABOVE the max are clamped.
    expect(body.llmRequestLogRetentionMs).toBe(maxMs);
  });
});

describe("PATCH /v1/config/privacy handler — Gap 2a-2 out-of-range clamp in response", () => {
  test("PATCH with only collectUsageData against out-of-range config.json clamps retention in response", async () => {
    const tooBig = 365 * 24 * 60 * 60 * 1000 + 1;
    writeFileSync(
      configPath,
      JSON.stringify({
        memory: {
          cleanup: {
            llmRequestLogRetentionMs: tooBig,
          },
        },
      }),
    );

    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ collectUsageData: false }));

    expect(res.status).toBe(200);
    const body = await res.json();
    // Even though the post-write config still has the out-of-range value
    // (the PATCH did not touch it), the response must echo the clamped
    // default. The gateway never serves an out-of-range value to clients.
    expect(body.llmRequestLogRetentionMs).toBe(DEFAULT_RETENTION_MS);
    // collectUsageData was updated, should echo.
    expect(body.collectUsageData).toBe(false);

    // Sanity: the on-disk value is untouched. We only sanitize on read;
    // we never silently rewrite user data on a PATCH that didn't ask for it.
    const config = readConfig();
    const cleanup = (config.memory as Record<string, unknown>)
      .cleanup as Record<string, unknown>;
    expect(cleanup.llmRequestLogRetentionMs).toBe(tooBig);
  });

  test("PATCH with only sendDiagnostics against a 10-year retention clamps response", async () => {
    const tenYearsMs = 10 * 365 * 24 * 60 * 60 * 1000;
    writeFileSync(
      configPath,
      JSON.stringify({
        memory: {
          cleanup: {
            llmRequestLogRetentionMs: tenYearsMs,
          },
        },
      }),
    );

    const handler = createPrivacyConfigPatchHandler();
    const res = await handler(makePatch({ sendDiagnostics: false }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llmRequestLogRetentionMs).toBe(DEFAULT_RETENTION_MS);
    expect(body.sendDiagnostics).toBe(false);
  });
});
