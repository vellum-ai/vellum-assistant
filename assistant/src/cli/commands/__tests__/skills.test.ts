/**
 * Tests for the `assistant skills` CLI command.
 *
 * Validates:
 *   - list calls listSkills with empty queryParams
 *   - inspect calls skillsLocalInspect with pathParam id
 *   - uninstall calls deleteSkill with pathParam id
 *   - install makes 1 IPC call (installSkill — handler does catalog lookup)
 *   - install IPC failure sets exitCode 1
 *   - install --overwrite passes overwrite:true
 *   - add calls installSkill with slug=source and origin: "skillssh"
 *   - search makes 2 IPC calls (listSkills then searchSkills)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** Ordered list of captured IPC calls for multi-call assertions. */
let ipcCalls: Array<{ method: string; params?: unknown }> = [];

/** Queue of results to return for successive cliIpcCall invocations. */
let mockIpcResults: Array<{
  ok: boolean;
  result?: unknown;
  error?: string;
  statusCode?: number;
}> = [];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    const next = mockIpcResults.shift();
    return next ?? { ok: true, result: { skills: [] } };
  },
  exitFromIpcResult: (r: { ok: boolean; error?: string; statusCode?: number }) => {
    process.exitCode = r.statusCode ?? 1;
  },
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerSkillsCommand } = await import("../skills.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalConsoleLog = console.log;
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  // Bun's console.log bypasses process.stdout.write — capture it separately
  console.log = (...logArgs: unknown[]) => {
    stdoutChunks.push(logArgs.map(String).join(" ") + "\n");
  };

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerSkillsCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    console.log = originalConsoleLog;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  ipcCalls = [];
  mockIpcResults = [];
  process.exitCode = 0;
});

// ===========================================================================
// skills list
// ===========================================================================

describe("skills list", () => {
  test("calls listSkills with empty queryParams", async () => {
    mockIpcResults = [{ ok: true, result: { skills: [] } }];

    await runCommand(["skills", "list"]);

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0]!.method).toBe("listSkills");
    expect((ipcCalls[0]!.params as { queryParams: unknown }).queryParams).toEqual({});
  });

  test("IPC failure sets exitCode 1", async () => {
    mockIpcResults = [{ ok: false, error: "Connection refused" }];

    const { exitCode } = await runCommand(["skills", "list"]);

    expect(exitCode).not.toBe(0);
  });

  test("--json IPC failure emits ok:false with error to stdout, exitCode set", async () => {
    mockIpcResults = [{ ok: false, error: "Connection refused" }];

    const { exitCode, stdout } = await runCommand([
      "skills",
      "list",
      "--json",
    ]);

    // Machine readers expect JSON on both success and failure paths.
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: false, error: "Connection refused" });
    expect(exitCode).not.toBe(0);
  });
});

// ===========================================================================
// skills inspect
// ===========================================================================

describe("skills inspect", () => {
  test("calls skillsLocalInspect with pathParam id", async () => {
    mockIpcResults = [
      {
        ok: true,
        result: {
          id: "weather",
          name: "Weather",
          description: "Get weather",
          emoji: null,
          source: "vellum",
          state: "enabled",
          directoryPath: "/path/to/weather",
          featureFlag: null,
          includes: null,
          activationHints: null,
          avoidWhen: null,
          toolManifest: null,
          installMeta: null,
          config: null,
        },
      },
    ];

    await runCommand(["skills", "inspect", "weather"]);

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0]!.method).toBe("skillsLocalInspect");
    expect((ipcCalls[0]!.params as { pathParams: unknown }).pathParams).toEqual({
      id: "weather",
    });
  });

  test("IPC failure sets exitCode 1", async () => {
    mockIpcResults = [{ ok: false, error: "Skill not found", statusCode: 404 }];

    const { exitCode } = await runCommand(["skills", "inspect", "nonexistent"]);

    expect(exitCode).not.toBe(0);
  });

  test("--json IPC failure emits ok:false with error to stdout, exitCode set", async () => {
    mockIpcResults = [
      { ok: false, error: "Skill not found", statusCode: 404 },
    ];

    const { exitCode, stdout } = await runCommand([
      "skills",
      "inspect",
      "nonexistent",
      "--json",
    ]);

    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: false, error: "Skill not found" });
    expect(exitCode).not.toBe(0);
  });
});

// ===========================================================================
// skills uninstall
// ===========================================================================

describe("skills uninstall", () => {
  test("calls deleteSkill with pathParam id", async () => {
    mockIpcResults = [{ ok: true, result: null }];

    await runCommand(["skills", "uninstall", "weather"]);

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0]!.method).toBe("deleteSkill");
    expect((ipcCalls[0]!.params as { pathParams: unknown }).pathParams).toEqual({
      id: "weather",
    });
  });

  test("IPC failure sets exitCode 1", async () => {
    mockIpcResults = [{ ok: false, error: "Not found" }];

    const { exitCode } = await runCommand(["skills", "uninstall", "weather"]);

    expect(exitCode).not.toBe(0);
  });

  test("--json IPC failure emits ok:false with error to stdout, exitCode set", async () => {
    mockIpcResults = [
      { ok: false, error: "Not found", statusCode: 404 },
    ];

    const { exitCode, stdout } = await runCommand([
      "skills",
      "uninstall",
      "weather",
      "--json",
    ]);

    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ ok: false, error: "Not found" });
    expect(exitCode).not.toBe(0);
  });
});

// ===========================================================================
// skills install
// ===========================================================================

describe("skills install", () => {
  test("calls installSkill directly (no preflight) with overwrite:false default", async () => {
    mockIpcResults = [{ ok: true, result: { ok: true, skillId: "weather" } }];

    await runCommand(["skills", "install", "weather"]);

    // No preflight via listSkills — the daemon's installSkill handler does
    // its own catalog lookup. Preflighting via listSkills(include=catalog)
    // would falsely "not found" when a community skill shadows a catalog id.
    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0]!.method).toBe("installSkill");
    expect((ipcCalls[0]!.params as { body: unknown }).body).toEqual({
      slug: "weather",
      overwrite: false,
    });
  });

  test("install failure surfaces exitCode 1 (text mode emits error + search hint via log.error)", async () => {
    mockIpcResults = [
      { ok: false, error: `Skill "nonexistent" not found in any registry` },
    ];

    const { exitCode } = await runCommand(["skills", "install", "nonexistent"]);

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0]!.method).toBe("installSkill");
    expect(exitCode).toBe(1);
    // The text-mode error path calls log.error twice (raw error + recovery
    // hint pointing at `skills search`). The mock logger swallows both — we
    // assert on exitCode here and rely on integration tests for the user UX.
  });

  test("--overwrite passes overwrite:true", async () => {
    mockIpcResults = [{ ok: true, result: { ok: true, skillId: "weather" } }];

    await runCommand(["skills", "install", "weather", "--overwrite"]);

    expect(ipcCalls).toHaveLength(1);
    expect((ipcCalls[0]!.params as { body: unknown }).body).toEqual({
      slug: "weather",
      overwrite: true,
    });
  });

  test("--json install failure emits ok:false with error, exitCode 1", async () => {
    mockIpcResults = [{ ok: false, error: "Connection refused" }];

    const { exitCode, stdout } = await runCommand([
      "skills",
      "install",
      "weather",
      "--json",
    ]);

    expect(ipcCalls).toHaveLength(1);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("Connection refused");
  });
});

// ===========================================================================
// skills add
// ===========================================================================

describe("skills add", () => {
  test("calls installSkill with slug=source and origin: 'skillssh'", async () => {
    mockIpcResults = [
      { ok: true, result: { ok: true, skillId: "find-skills" } },
    ];

    await runCommand(["skills", "add", "vercel-labs/skills@find-skills"]);

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0]!.method).toBe("installSkill");
    // origin: "skillssh" is required so the daemon routes via resolveSkillSource
    // for all skills.sh-flavoured sources — including the `@`-format which the
    // auto-detect `looksLikeSkillsShSlug()` would otherwise miss (2 segments).
    expect((ipcCalls[0]!.params as { body: unknown }).body).toEqual({
      slug: "vercel-labs/skills@find-skills",
      origin: "skillssh",
      overwrite: false,
    });
  });

  test("3-segment slug also passes origin: 'skillssh'", async () => {
    mockIpcResults = [
      { ok: true, result: { ok: true, skillId: "find-skills" } },
    ];

    await runCommand(["skills", "add", "vercel-labs/skills/find-skills"]);

    expect(ipcCalls).toHaveLength(1);
    expect((ipcCalls[0]!.params as { body: unknown }).body).toEqual({
      slug: "vercel-labs/skills/find-skills",
      origin: "skillssh",
      overwrite: false,
    });
  });

  test("--overwrite passes overwrite:true", async () => {
    mockIpcResults = [
      { ok: true, result: { ok: true, skillId: "find-skills" } },
    ];

    await runCommand([
      "skills",
      "add",
      "vercel-labs/skills@find-skills",
      "--overwrite",
    ]);

    expect(ipcCalls).toHaveLength(1);
    expect((ipcCalls[0]!.params as { body: unknown }).body).toEqual({
      slug: "vercel-labs/skills@find-skills",
      origin: "skillssh",
      overwrite: true,
    });
  });

  test("IPC failure sets exitCode 1", async () => {
    mockIpcResults = [{ ok: false, error: "Not found" }];

    const { exitCode } = await runCommand([
      "skills",
      "add",
      "vercel-labs/skills@find-skills",
    ]);

    expect(exitCode).not.toBe(0);
  });

  test("--json IPC failure emits ok:false with error to stdout, exitCode set", async () => {
    mockIpcResults = [
      { ok: false, error: "Not a valid skills.sh source" },
    ];

    const { exitCode, stdout } = await runCommand([
      "skills",
      "add",
      "garbage-input",
      "--json",
    ]);

    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({
      ok: false,
      error: "Not a valid skills.sh source",
    });
    expect(exitCode).not.toBe(0);
  });
});

// ===========================================================================
// skills search
// ===========================================================================

describe("skills search", () => {
  test("makes 2 IPC calls (listSkills then searchSkills)", async () => {
    mockIpcResults = [
      { ok: true, result: { skills: [] } },
      { ok: true, result: { skills: [] } },
    ];

    await runCommand(["skills", "search", "react"]);

    expect(ipcCalls).toHaveLength(2);
    expect(ipcCalls[0]!.method).toBe("listSkills");
    expect(
      (ipcCalls[0]!.params as { queryParams: unknown }).queryParams,
    ).toEqual({ include: "catalog", q: "react" });
    expect(ipcCalls[1]!.method).toBe("searchSkills");
    expect(
      (ipcCalls[1]!.params as { queryParams: unknown }).queryParams,
    ).toEqual({ q: "react" });
  });

  test("--json outputs ok:true with catalog, community, clawhub keys", async () => {
    mockIpcResults = [
      {
        ok: true,
        result: {
          skills: [
            {
              id: "react-tools",
              name: "React Tools",
              description: "React helpers",
              origin: "vellum",
              kind: "catalog",
              status: "available",
            },
          ],
        },
      },
      { ok: true, result: { skills: [] } },
    ];

    const { exitCode, stdout } = await runCommand([
      "skills",
      "search",
      "react",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed).toHaveProperty("catalog");
    expect(parsed).toHaveProperty("community");
    expect(parsed).toHaveProperty("clawhub");
    expect(parsed.catalog).toHaveLength(1);
    expect(parsed.catalog[0].id).toBe("react-tools");
  });

  test("both IPC failures: outputs catalogError and communityError in --json", async () => {
    mockIpcResults = [
      { ok: false, error: "catalog unavailable" },
      { ok: false, error: "community unavailable" },
    ];

    const { stdout } = await runCommand([
      "skills",
      "search",
      "react",
      "--json",
    ]);

    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.catalogError).toBe("catalog unavailable");
    expect(parsed.communityError).toBe("community unavailable");
  });

  test("deduplicates by id — vellum wins over community", async () => {
    mockIpcResults = [
      {
        ok: true,
        result: {
          skills: [
            {
              id: "react-tools",
              name: "React Tools",
              description: "Vellum version",
              origin: "vellum",
              kind: "catalog",
              status: "available",
            },
          ],
        },
      },
      {
        ok: true,
        result: {
          skills: [
            {
              id: "react-tools",
              name: "React Tools Community",
              description: "Community version",
              origin: "skillssh",
              kind: "community",
              status: "available",
            },
          ],
        },
      },
    ];

    const { stdout } = await runCommand([
      "skills",
      "search",
      "react",
      "--json",
    ]);

    const parsed = JSON.parse(stdout);
    // vellum skill should be in catalog
    expect(parsed.catalog).toHaveLength(1);
    expect(parsed.catalog[0].origin).toBe("vellum");
    // community skill with same id should be deduplicated out
    expect(parsed.community).toHaveLength(0);
  });
});
