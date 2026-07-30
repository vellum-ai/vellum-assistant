/**
 * Tests for the `assistant memory ingest` CLI subcommand.
 *
 * Validates:
 *   - Registration under `memory` and the `memory_ingest` operation id with a
 *     long per-batch IPC timeout.
 *   - --dir walking: nested .md files derive slugs from relative paths with
 *     forward slashes (people/alice.md becomes people/alice).
 *   - Chunking: manifests above 200 pages fan out into multiple IPC calls and
 *     the summary aggregates across batches.
 *   - --dry-run and --overwrite pass through to the request body.
 *   - Invalid page results set exit code 1.
 *   - Malformed manifests are rejected client-side without any IPC call.
 *   - Mid-run daemon failures keep the --json contract (error envelope with
 *     the partial aggregate from committed batches), print partial counts in
 *     text mode, and map the IPC status to the standard exit codes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

import { assertNotLiveDb } from "../../../../__tests__/assert-not-live-db.js";
import { applyCommandHelp } from "../../../lib/cli-command-help.js";
import { memoryHelp } from "../index.help.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

interface CapturedIpcCall {
  method: string;

  params?: any;
  options?: { timeoutMs?: number; signal?: AbortSignal };
}

/** Every `cliIpcCall` invocation, in order. */
let ipcCalls: CapturedIpcCall[] = [];

/** Computes the mock IPC result for each call; overridable per test. */
let ipcHandler: (method: string, params?: any) => any = defaultIpcHandler;

/** Captured log output for assertion. */
let logOutput: string[] = [];

/** Success result echoing one `written` entry per requested page. */
function defaultIpcHandler(_method: string, params?: any) {
  const pages = (params?.body?.pages ?? []) as {
    slug: string;
    content: string;
  }[];
  return {
    ok: true,
    result: {
      results: pages.map((p) => ({
        slug: p.slug,
        action: "written",
        warnings: [],
      })),
      written: pages.length,
      skipped: 0,
      invalid: 0,
      dryRun: params?.body?.dryRun === true,
    },
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (
    method: string,

    params?: any,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => {
    ipcCalls.push({ method, params, options });
    return ipcHandler(method, params);
  },
  exitFromIpcResult: (r: { statusCode?: number }) => {
    process.exitCode = r.statusCode === undefined ? 10 : 1;
  },
  // Mirrors the real exit-code matrix (cli-client.ts): no statusCode = 10
  // (transport), 5xx = 3, 4xx = 2, otherwise 1.
  exitCodeFromIpcResult: (r: { statusCode?: number }) => {
    if (r.statusCode === undefined) {
      return 10;
    }
    if (r.statusCode >= 500) {
      return 3;
    }
    if (r.statusCode >= 400) {
      return 2;
    }
    return 1;
  },
}));

// The CLI lazily imports the batch cap from the plugin's route module; mock
// it so the test never loads daemon route internals (config loader, route
// policy, ...). Only the constant is consumed at runtime - the
// MemoryIngestResult import is type-only and erased. The value comes from
// the substrate module (the constant's true owner, cheap to import) so the
// chunking tests track the real cap instead of a hardcoded copy.
import { MAX_INGEST_PAGES_PER_CALL } from "../../../../plugins/defaults/memory/substrate/ingest.js";

mock.module(
  "../../../../plugins/defaults/memory/src/memory-ingest-routes.js",
  () => ({
    MAX_INGEST_PAGES_PER_CALL,
  }),
);

const capture = (...args: unknown[]) => {
  logOutput.push(args.map(String).join(" "));
};
const fakeLogger = {
  info: capture,
  warn: capture,
  error: capture,
  debug: () => {},
};
mock.module("../../../../util/logger.js", () => ({
  getLogger: () => fakeLogger,
  getCliLogger: () => fakeLogger,
}));

// ---------------------------------------------------------------------------
// Import modules under test (after mocks)
// ---------------------------------------------------------------------------

const { registerMemoryIngestCommand } = await import("../memory-ingest.js");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  const memory = program.command("memory");
  applyCommandHelp(memory, memoryHelp);
  registerMemoryIngestCommand(memory);
  return program;
}

async function runCommand(args: string[]): Promise<{ exitCode: number }> {
  process.exitCode = 0;
  try {
    const program = buildProgram();
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) {
      process.exitCode = 1;
    }
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  return { exitCode };
}

/** Create a temp dir, run the callback, and always clean it up. */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "memory-ingest-test-"));
  try {
    await fn(dir);
  } finally {
    assertNotLiveDb(dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write a JSON manifest of `count` synthetic pages and return its path. */
function writeManifest(dir: string, count: number): string {
  const pages = Array.from({ length: count }, (_, i) => ({
    slug: `topics/page-${String(i).padStart(3, "0")}`,
    content: `---\ntitle: Page ${i}\n---\nBody ${i}\n`,
  }));
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify(pages));
  return path;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  ipcCalls = [];
  ipcHandler = defaultIpcHandler;
  logOutput = [];
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Registration + operation id
// ---------------------------------------------------------------------------

describe("registration", () => {
  test("registers ingest under memory", () => {
    const program = buildProgram();
    const memory = program.commands.find((c) => c.name() === "memory");
    expect(memory).toBeDefined();
    const ingest = memory!.commands.find((c) => c.name() === "ingest");
    expect(ingest).toBeDefined();
  });

  test("sends memory_ingest with a 5-minute per-batch IPC timeout", async () => {
    await withTempDir(async (dir) => {
      const manifest = writeManifest(dir, 2);
      const { exitCode } = await runCommand([
        "memory",
        "ingest",
        "--file",
        manifest,
      ]);

      expect(exitCode).toBe(0);
      expect(ipcCalls).toHaveLength(1);
      expect(ipcCalls[0].method).toBe("memory_ingest");
      expect(ipcCalls[0].options!.timeoutMs).toBe(5 * 60 * 1000);
    });
  });
});

// ---------------------------------------------------------------------------
// --dir walking + slug derivation
// ---------------------------------------------------------------------------

describe("--dir input", () => {
  test("derives slugs from relative paths with forward slashes", async () => {
    await withTempDir(async (dir) => {
      mkdirSync(join(dir, "people"), { recursive: true });
      writeFileSync(join(dir, "people", "alice.md"), "# Alice\n");
      writeFileSync(join(dir, "top.md"), "# Top\n");
      writeFileSync(join(dir, "notes.txt"), "not a page");

      const { exitCode } = await runCommand(["memory", "ingest", "--dir", dir]);

      expect(exitCode).toBe(0);
      expect(ipcCalls).toHaveLength(1);
      const pages = ipcCalls[0].params!.body.pages as {
        slug: string;
        content: string;
      }[];
      expect(pages.map((p) => p.slug)).toEqual(["people/alice", "top"]);
      expect(pages[0].content).toBe("# Alice\n");
      expect(pages[1].content).toBe("# Top\n");
    });
  });

  test("fails with an actionable error when the directory does not exist", async () => {
    const { exitCode } = await runCommand([
      "memory",
      "ingest",
      "--dir",
      "/nonexistent/staging-dir",
    ]);

    expect(exitCode).toBe(1);
    expect(ipcCalls).toHaveLength(0);
    expect(logOutput.join("\n")).toContain("Directory not found");
  });
});

// ---------------------------------------------------------------------------
// Chunking + aggregation
// ---------------------------------------------------------------------------

describe("batching", () => {
  test("chunks above 200 pages into multiple IPC calls and aggregates the summary", async () => {
    await withTempDir(async (dir) => {
      const manifest = writeManifest(dir, 250);

      const { exitCode } = await runCommand([
        "memory",
        "ingest",
        "--file",
        manifest,
        "--json",
      ]);

      expect(exitCode).toBe(0);
      expect(ipcCalls).toHaveLength(2);
      expect(ipcCalls[0].params!.body.pages).toHaveLength(200);
      expect(ipcCalls[1].params!.body.pages).toHaveLength(50);

      const summary = JSON.parse(logOutput.at(-1)!);
      expect(summary.written).toBe(250);
      expect(summary.skipped).toBe(0);
      expect(summary.invalid).toBe(0);
      expect(summary.results).toHaveLength(250);
    });
  });
});

// ---------------------------------------------------------------------------
// Mid-run daemon failures: partial results + exit code
// ---------------------------------------------------------------------------

describe("mid-run daemon failure", () => {
  /** Fail the second batch with a 409 after batch 1 committed 200 pages. */
  function failSecondBatch(): void {
    let call = 0;
    ipcHandler = (method, params) => {
      call += 1;
      if (call >= 2) {
        return {
          ok: false,
          error: "Ingest is locked: consolidation in progress",
          statusCode: 409,
        };
      }
      return defaultIpcHandler(method, params);
    };
  }

  test("--json emits an error envelope with the partial aggregate from committed batches", async () => {
    failSecondBatch();

    await withTempDir(async (dir) => {
      const manifest = writeManifest(dir, 250);

      const { exitCode } = await runCommand([
        "memory",
        "ingest",
        "--file",
        manifest,
        "--json",
      ]);

      // 409 maps to exit code 2 (daemon 4xx).
      expect(exitCode).toBe(2);
      expect(ipcCalls).toHaveLength(2);

      const envelope = JSON.parse(logOutput.at(-1)!);
      expect(envelope.ok).toBe(false);
      expect(envelope.error).toContain("Ingest is locked");
      expect(envelope.partial.written).toBe(200);
      expect(envelope.partial.skipped).toBe(0);
      expect(envelope.partial.invalid).toBe(0);
      expect(envelope.partial.results).toHaveLength(200);
    });
  });

  test("text mode prints the error and the partial written/skipped/invalid counts", async () => {
    failSecondBatch();

    await withTempDir(async (dir) => {
      const manifest = writeManifest(dir, 250);

      const { exitCode } = await runCommand([
        "memory",
        "ingest",
        "--file",
        manifest,
      ]);

      expect(exitCode).toBe(2);
      const output = logOutput.join("\n");
      expect(output).toContain("Ingest is locked");
      expect(output).toContain("wrote 200 page(s)");
      expect(output).toContain("skipped 0 existing");
      expect(output).toContain("0 invalid");
    });
  });

  test("a transport failure with no statusCode exits 10", async () => {
    ipcHandler = () => ({ ok: false, error: "Daemon is not running" });

    await withTempDir(async (dir) => {
      const manifest = writeManifest(dir, 1);

      const { exitCode } = await runCommand([
        "memory",
        "ingest",
        "--file",
        manifest,
        "--json",
      ]);

      expect(exitCode).toBe(10);
      const envelope = JSON.parse(logOutput.at(-1)!);
      expect(envelope.ok).toBe(false);
      expect(envelope.error).toContain("Daemon is not running");
      expect(envelope.partial.written).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Flag pass-through
// ---------------------------------------------------------------------------

describe("flag pass-through", () => {
  test("--dry-run and --overwrite are forwarded in the request body", async () => {
    await withTempDir(async (dir) => {
      const manifest = writeManifest(dir, 1);

      const { exitCode } = await runCommand([
        "memory",
        "ingest",
        "--file",
        manifest,
        "--dry-run",
        "--overwrite",
      ]);

      expect(exitCode).toBe(0);
      expect(ipcCalls).toHaveLength(1);
      expect(ipcCalls[0].params!.body.dryRun).toBe(true);
      expect(ipcCalls[0].params!.body.overwrite).toBe(true);
    });
  });

  test("omits dryRun and overwrite from the body when the flags are absent", async () => {
    await withTempDir(async (dir) => {
      const manifest = writeManifest(dir, 1);

      await runCommand(["memory", "ingest", "--file", manifest]);

      expect(ipcCalls).toHaveLength(1);
      expect(ipcCalls[0].params!.body).not.toContainKey("dryRun");
      expect(ipcCalls[0].params!.body).not.toContainKey("overwrite");
    });
  });
});

// ---------------------------------------------------------------------------
// Invalid results
// ---------------------------------------------------------------------------

describe("invalid page results", () => {
  test("sets exit code 1 and reports each invalid slug", async () => {
    ipcHandler = () => ({
      ok: true,
      result: {
        results: [
          { slug: "good/page", action: "written", warnings: [] },
          {
            slug: "bad/page",
            action: "invalid",
            warnings: [],
            error: "missing frontmatter",
          },
        ],
        written: 1,
        skipped: 0,
        invalid: 1,
        dryRun: false,
      },
    });

    await withTempDir(async (dir) => {
      const manifest = writeManifest(dir, 2);

      const { exitCode } = await runCommand([
        "memory",
        "ingest",
        "--file",
        manifest,
      ]);

      expect(exitCode).toBe(1);
      const output = logOutput.join("\n");
      expect(output).toContain("bad/page");
      expect(output).toContain("missing frontmatter");
    });
  });
});

// ---------------------------------------------------------------------------
// Client-side validation
// ---------------------------------------------------------------------------

describe("manifest validation", () => {
  test("rejects duplicate slugs that would land in different chunks, with no IPC call", async () => {
    await withTempDir(async (dir) => {
      // 201 entries: entry 0 and entry 200 share a slug, so they would be
      // split across two 200-page batches and evade the route's per-request
      // duplicate check.
      const manifest = Array.from({ length: 201 }, (_, i) => ({
        slug: i === 200 ? "page-0" : `page-${String(i)}`,
        content: "body",
      }));
      const path = join(dir, "manifest.json");
      writeFileSync(path, JSON.stringify(manifest));

      const { exitCode } = await runCommand([
        "memory",
        "ingest",
        "--file",
        path,
      ]);

      expect(exitCode).toBe(1);
      expect(ipcCalls).toHaveLength(0);
      expect(logOutput.join("\n")).toContain("Duplicate slugs in input");
      expect(logOutput.join("\n")).toContain("page-0");
    });
  });

  test("rejects a non-array manifest without any IPC call", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "manifest.json");
      writeFileSync(path, JSON.stringify({ not: "an array" }));

      const { exitCode } = await runCommand([
        "memory",
        "ingest",
        "--file",
        path,
      ]);

      expect(exitCode).toBe(1);
      expect(ipcCalls).toHaveLength(0);
      expect(logOutput.join("\n")).toContain("must be a JSON array");
    });
  });

  test("rejects a page missing content with a per-index error and no IPC call", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "manifest.json");
      writeFileSync(
        path,
        JSON.stringify([
          { slug: "ok/page", content: "body" },
          { slug: "broken/page" },
        ]),
      );

      const { exitCode } = await runCommand([
        "memory",
        "ingest",
        "--file",
        path,
      ]);

      expect(exitCode).toBe(1);
      expect(ipcCalls).toHaveLength(0);
      expect(logOutput.join("\n")).toContain("[1].content");
    });
  });

  test("rejects unparseable JSON without any IPC call", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "manifest.json");
      writeFileSync(path, "{ not json");

      const { exitCode } = await runCommand([
        "memory",
        "ingest",
        "--file",
        path,
      ]);

      expect(exitCode).toBe(1);
      expect(ipcCalls).toHaveLength(0);
      expect(logOutput.join("\n")).toContain("Invalid JSON manifest");
    });
  });

  test("rejects passing both --dir and --file", async () => {
    await withTempDir(async (dir) => {
      const manifest = writeManifest(dir, 1);

      const { exitCode } = await runCommand([
        "memory",
        "ingest",
        "--dir",
        dir,
        "--file",
        manifest,
      ]);

      expect(exitCode).toBe(1);
      expect(ipcCalls).toHaveLength(0);
      expect(logOutput.join("\n")).toContain("not both");
    });
  });
});
