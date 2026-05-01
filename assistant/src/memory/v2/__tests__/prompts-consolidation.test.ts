/**
 * Tests for `assistant/src/memory/v2/prompts/consolidation.ts` —
 * specifically `resolveConsolidationPrompt` which loads an optional
 * file-based override and falls back to the bundled prompt when the
 * override is missing/empty/unreadable.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const warnCalls: Array<{ data: unknown; msg: string }> = [];
const recordingLogger = {
  warn: (data: unknown, msg: string) => {
    warnCalls.push({ data, msg });
  },
  info: () => {},
  debug: () => {},
  error: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => recordingLogger,
};

mock.module("../../../util/logger.js", () => ({
  getLogger: () => recordingLogger,
}));

let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "memory-v2-prompt-test-"));
  previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;
});

afterAll(() => {
  if (previousWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  }
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

const { CONSOLIDATION_PROMPT, CUTOFF_PLACEHOLDER, resolveConsolidationPrompt } =
  await import("../prompts/consolidation.js");

const CUTOFF = "2026-05-01T12:00:00.000Z";

const bundledPrompt = (): string =>
  (CONSOLIDATION_PROMPT as string).replaceAll(CUTOFF_PLACEHOLDER, CUTOFF);

beforeEach(() => {
  warnCalls.length = 0;
  mkdirSync(tmpWorkspace, { recursive: true });
});

afterEach(() => {
  for (const entry of ["custom-prompt.md", "empty.md", "no-placeholder.md"]) {
    rmSync(join(tmpWorkspace, entry), { force: true });
  }
});

describe("resolveConsolidationPrompt — no override", () => {
  test("returns the bundled prompt with {{CUTOFF}} substituted when overridePath is null", () => {
    const result = resolveConsolidationPrompt(null, CUTOFF);
    expect(result).toContain("You are running memory consolidation");
    expect(result).toContain(CUTOFF);
    expect(result).not.toContain(CUTOFF_PLACEHOLDER);
    expect(warnCalls).toHaveLength(0);
  });
});

describe("resolveConsolidationPrompt — with override", () => {
  test("loads an absolute path verbatim and substitutes {{CUTOFF}}", () => {
    const path = join(tmpWorkspace, "custom-prompt.md");
    writeFileSync(path, "Custom prompt at {{CUTOFF}}\n");

    const result = resolveConsolidationPrompt(path, CUTOFF);

    expect(result).toBe(`Custom prompt at ${CUTOFF}\n`);
    expect(warnCalls).toHaveLength(0);
  });

  test("resolves a relative path against the workspace dir", () => {
    writeFileSync(
      join(tmpWorkspace, "custom-prompt.md"),
      "Workspace-relative {{CUTOFF}}\n",
    );

    const result = resolveConsolidationPrompt("custom-prompt.md", CUTOFF);

    expect(result).toBe(`Workspace-relative ${CUTOFF}\n`);
    expect(warnCalls).toHaveLength(0);
  });

  test("expands a leading ~/ to the home directory", () => {
    const filename = `.vellum-prompt-test-${process.pid}.md`;
    const path = join(homedir(), filename);
    writeFileSync(path, "Home dir {{CUTOFF}}\n");
    try {
      const result = resolveConsolidationPrompt(`~/${filename}`, CUTOFF);
      expect(result).toBe(`Home dir ${CUTOFF}\n`);
      expect(warnCalls).toHaveLength(0);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("returns the file body verbatim when {{CUTOFF}} is absent", () => {
    const body = "No placeholder here. Just a plain prompt.\n";
    writeFileSync(join(tmpWorkspace, "no-placeholder.md"), body);

    const result = resolveConsolidationPrompt("no-placeholder.md", CUTOFF);

    expect(result).toBe(body);
    expect(warnCalls).toHaveLength(0);
  });

  test("substitutes every {{CUTOFF}} occurrence (replaceAll, not replace)", () => {
    writeFileSync(
      join(tmpWorkspace, "custom-prompt.md"),
      "{{CUTOFF}} ... {{CUTOFF}} ... {{CUTOFF}}",
    );

    const result = resolveConsolidationPrompt("custom-prompt.md", CUTOFF);

    expect(result).toBe(`${CUTOFF} ... ${CUTOFF} ... ${CUTOFF}`);
    expect(result).not.toContain(CUTOFF_PLACEHOLDER);
  });
});

describe("resolveConsolidationPrompt — failure modes", () => {
  test("falls back to bundled prompt and logs a warning when the file is missing", () => {
    const result = resolveConsolidationPrompt(
      "/this/path/does/not/exist.md",
      CUTOFF,
    );

    expect(result).toBe(bundledPrompt());
    expect(warnCalls).toHaveLength(1);
    const data = warnCalls[0].data as Record<string, unknown>;
    expect(data.code).toBe("ENOENT");
    expect(data.fallback).toBe("bundled");
  });

  test("falls back to bundled prompt when the file is empty", () => {
    const path = join(tmpWorkspace, "empty.md");
    writeFileSync(path, "");

    const result = resolveConsolidationPrompt(path, CUTOFF);

    expect(result).toBe(bundledPrompt());
    expect(warnCalls).toHaveLength(1);
    const data = warnCalls[0].data as Record<string, unknown>;
    expect(data.reason).toBe("empty_override");
  });

  test("falls back to bundled prompt when the file is whitespace-only", () => {
    const path = join(tmpWorkspace, "empty.md");
    writeFileSync(path, "   \n\n\t\n");

    const result = resolveConsolidationPrompt(path, CUTOFF);

    expect(result).toBe(bundledPrompt());
    expect(warnCalls).toHaveLength(1);
    const data = warnCalls[0].data as Record<string, unknown>;
    expect(data.reason).toBe("empty_override");
  });
});
