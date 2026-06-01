import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AssistantEntry } from "../lib/assistant-config.js";
import { flags } from "../commands/flags.js";

const testDir = mkdtempSync(join(tmpdir(), "cli-flags-test-"));
const originalArgv = [...process.argv];
const originalExit = process.exit;
const originalFetch = globalThis.fetch;
const originalLockfileDir = process.env.VELLUM_LOCKFILE_DIR;

let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;
let fetchCalls: Array<{ url: string; method: string }>;

function makeEntry(
  assistantId: string,
  extra: Partial<AssistantEntry> = {},
): AssistantEntry {
  return {
    assistantId,
    runtimeUrl: `http://127.0.0.1:${7800 + assistantId.length}`,
    cloud: "local",
    ...extra,
  };
}

function writeLockfile(
  entries: AssistantEntry[],
  activeAssistant?: string,
): void {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(
    join(testDir, ".vellum.lock.json"),
    JSON.stringify(
      {
        assistants: entries,
        ...(activeAssistant ? { activeAssistant } : {}),
      },
      null,
      2,
    ),
  );
}

/**
 * Build a Response stub that callers shape per subcommand. `setFlag` needs
 * a 200 OK with the gateway's updated flag payload; `getFlag`/`listFlags`
 * need a flag list. Body content is the minimal valid shape — the tests
 * exercise URL routing, not response parsing.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("vellum flags --assistant routing", () => {
  beforeEach(() => {
    process.env.VELLUM_LOCKFILE_DIR = testDir;
    rmSync(join(testDir, ".vellum.lock.json"), { force: true });
    fetchCalls = [];
    // Capture every outgoing fetch and respond with a stub matching the
    // subcommand's expected shape. The URL is what the test asserts on.
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      fetchCalls.push({ url, method });
      if (method === "PATCH") {
        return jsonResponse({
          key: "external-plugins",
          enabled: true,
          defaultEnabled: false,
          label: "External Plugins",
          description: "test",
        });
      }
      return jsonResponse({ flags: [] });
    }) as typeof globalThis.fetch;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit;
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    globalThis.fetch = originalFetch;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  afterAll(() => {
    if (originalLockfileDir === undefined) {
      delete process.env.VELLUM_LOCKFILE_DIR;
    } else {
      process.env.VELLUM_LOCKFILE_DIR = originalLockfileDir;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  test("set --assistant <id> routes to the explicit instance's runtime URL, not the active one", async () => {
    // Two assistants on different ports. The active one is "alice"; the
    // explicit --assistant target is "bob". A correct routing impl hits
    // bob's URL — a regression that silently uses the active assistant
    // would hit alice's URL.
    writeLockfile(
      [
        makeEntry("alice-1", { name: "Alice" }),
        makeEntry("bob-2", { name: "Bob" }),
      ],
      "alice-1",
    );
    process.argv = [
      "bun",
      "vellum",
      "flags",
      "set",
      "external-plugins",
      "true",
      "--assistant",
      "Bob",
    ];

    await flags();

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].method).toBe("PATCH");
    // bob-2 has assistantId.length === 5, so port = 7800 + 5 = 7805.
    expect(fetchCalls[0].url).toContain("http://127.0.0.1:7805");
    expect(fetchCalls[0].url).toContain(
      "/v1/assistants/bob-2/feature-flags/external-plugins",
    );
  });

  test("set --assistant <id> placed BEFORE positional args still parses correctly", async () => {
    // Eval harness composes `vellum flags set <key> <value> --assistant <id>`
    // but human users might write `--assistant <id> set <key> <value>`.
    // The extractor strips --assistant from anywhere in argv so positional
    // parsing downstream sees the same shape either way.
    writeLockfile([
      makeEntry("alice-1", { name: "Alice" }),
      makeEntry("bob-2", { name: "Bob" }),
    ]);
    process.argv = [
      "bun",
      "vellum",
      "flags",
      "--assistant",
      "Bob",
      "set",
      "external-plugins",
      "true",
    ];

    await flags();

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain(
      "/v1/assistants/bob-2/feature-flags/external-plugins",
    );
  });

  test("set without --assistant uses the active assistant", async () => {
    // Backwards-compat: behavior unchanged for invocations that don't
    // pass --assistant. The active assistant ("alice-1") wins.
    writeLockfile(
      [
        makeEntry("alice-1", { name: "Alice" }),
        makeEntry("bob-2", { name: "Bob" }),
      ],
      "alice-1",
    );
    process.argv = [
      "bun",
      "vellum",
      "flags",
      "set",
      "external-plugins",
      "true",
    ];

    await flags();

    expect(fetchCalls.length).toBe(1);
    // alice-1 has assistantId.length === 7, so port = 7800 + 7 = 7807.
    expect(fetchCalls[0].url).toContain("http://127.0.0.1:7807");
    expect(fetchCalls[0].url).toContain(
      "/v1/assistants/alice-1/feature-flags/external-plugins",
    );
  });

  test("set --assistant <name> exits with a lookup error when no assistant matches", async () => {
    writeLockfile([makeEntry("alice-1", { name: "Alice" })]);
    process.argv = [
      "bun",
      "vellum",
      "flags",
      "set",
      "external-plugins",
      "true",
      "--assistant",
      "Ghost",
    ];

    // The Error thrown by createClient propagates out of flags().
    // No fetch should ever fire because lookup fails before the
    // AssistantClient is constructed.
    await expect(flags()).rejects.toThrow(/Ghost/);
    expect(fetchCalls.length).toBe(0);
  });

  test("--assistant without a value exits via the explicit missing-value branch", async () => {
    writeLockfile([makeEntry("alice-1", { name: "Alice" })]);
    process.argv = [
      "bun",
      "vellum",
      "flags",
      "set",
      "external-plugins",
      "true",
      "--assistant",
    ];

    await expect(flags()).rejects.toThrow(/process\.exit:1/);
    expect(consoleErrorSpy.mock.calls.flat().join("\n")).toContain(
      "Missing value for --assistant <name>",
    );
    expect(fetchCalls.length).toBe(0);
  });
});
