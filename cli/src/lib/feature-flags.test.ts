import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isAssistantFeatureFlagEnabled,
  WEB_REMOTE_INGRESS_FLAG,
} from "./feature-flags.js";

const testDir = mkdtempSync(join(tmpdir(), "cli-feature-flags-test-"));
const originalFetch = globalThis.fetch;
const originalLockfileDir = process.env.VELLUM_LOCKFILE_DIR;

function writeLockfile(): void {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(
    join(testDir, ".vellum.lock.json"),
    JSON.stringify(
      {
        activeAssistant: "assistant-1",
        assistants: [
          {
            assistantId: "assistant-1",
            runtimeUrl: "http://127.0.0.1:7830",
            cloud: "local",
          },
        ],
      },
      null,
      2,
    ),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(response: Response): void {
  const fetchMock = async () => response;
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
}

describe("isAssistantFeatureFlagEnabled", () => {
  beforeEach(() => {
    process.env.VELLUM_LOCKFILE_DIR = testDir;
    rmSync(join(testDir, ".vellum.lock.json"), { force: true });
    writeLockfile();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    if (originalLockfileDir === undefined) {
      delete process.env.VELLUM_LOCKFILE_DIR;
    } else {
      process.env.VELLUM_LOCKFILE_DIR = originalLockfileDir;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  test("returns true when the assistant flag is enabled", async () => {
    mockFetch(
      jsonResponse({
        flags: [{ key: WEB_REMOTE_INGRESS_FLAG, enabled: true }],
      }),
    );

    await expect(
      isAssistantFeatureFlagEnabled("assistant-1", WEB_REMOTE_INGRESS_FLAG),
    ).resolves.toBe(true);
  });

  test("returns false when the assistant flag is disabled or missing", async () => {
    mockFetch(
      jsonResponse({
        flags: [{ key: WEB_REMOTE_INGRESS_FLAG, enabled: false }],
      }),
    );

    await expect(
      isAssistantFeatureFlagEnabled("assistant-1", WEB_REMOTE_INGRESS_FLAG),
    ).resolves.toBe(false);

    mockFetch(jsonResponse({ flags: [] }));

    await expect(
      isAssistantFeatureFlagEnabled("assistant-1", WEB_REMOTE_INGRESS_FLAG),
    ).resolves.toBe(false);
  });

  test("throws when the gateway rejects the flag request", async () => {
    mockFetch(jsonResponse({ error: "nope" }, 500));

    await expect(
      isAssistantFeatureFlagEnabled("assistant-1", WEB_REMOTE_INGRESS_FLAG),
    ).rejects.toThrow("Failed to fetch feature flags");
  });
});
