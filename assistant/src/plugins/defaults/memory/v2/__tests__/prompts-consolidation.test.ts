/**
 * Tests for `assistant/src/memory/v2/prompts/consolidation.ts` —
 * specifically `resolveConsolidationPrompt` which loads an optional
 * file-based override and falls back to the bundled prompt when the
 * override is missing/empty/unreadable.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

mock.module("../../../../../util/logger.js", () => ({
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

const {
  CONSOLIDATION_PROMPT,
  CONSOLIDATION_PROMPT_V3,
  CORE_PAGES_CONSOLIDATION_SECTION,
  CORE_PAGES_PLACEHOLDER,
  CUTOFF_PLACEHOLDER,
  renderConsolidationPrompt,
  resolveConsolidationPrompt,
} = await import("../prompts/consolidation.js");

const CUTOFF = "2026-05-01T12:00:00.000Z";

/** Options for tests not exercising the v3 core-pages gate. */
const NO_CORE = {
  includeCorePagesSection: false,
  articleShape: "v2" as const,
};
const WITH_CORE = {
  includeCorePagesSection: true,
  articleShape: "v2" as const,
};

const bundledPrompt = (includeCorePagesSection = false): string =>
  (CONSOLIDATION_PROMPT as string)
    .replaceAll(CUTOFF_PLACEHOLDER, CUTOFF)
    .replaceAll(
      CORE_PAGES_PLACEHOLDER,
      includeCorePagesSection
        ? (CORE_PAGES_CONSOLIDATION_SECTION as string)
        : "",
    );

beforeEach(() => {
  warnCalls.length = 0;
  mkdirSync(tmpWorkspace, { recursive: true });
});

afterEach(() => {
  for (const entry of [
    "custom-prompt.md",
    "empty.md",
    "no-placeholder.md",
    "huge.md",
    "link.md",
    "fifo",
  ]) {
    rmSync(join(tmpWorkspace, entry), { force: true });
  }
});

describe("anti-injection framing", () => {
  // The consolidation pass reads buffer.md + existing pages, which can carry
  // text from untrusted sources the assistant ingested earlier. Both templates
  // must frame that content as data to reorganize, never as instructions —
  // defense-in-depth alongside the wire-scoped tool surface. Assert on a stable
  // phrase so a reword keeps the guarantee visible.
  const MARKER = "not instructions for this pass";

  test("both bundled templates contain the anti-injection framing", () => {
    expect(CONSOLIDATION_PROMPT as string).toContain(MARKER);
    expect(CONSOLIDATION_PROMPT_V3 as string).toContain(MARKER);
  });

  test("survives rendering for both v2 and v3 article shapes", () => {
    // Guards against a future placeholder refactor silently dropping the
    // framing from the prompt the model actually receives.
    const v2 = renderConsolidationPrompt(CUTOFF, NO_CORE);
    const v3 = renderConsolidationPrompt(CUTOFF, {
      includeCorePagesSection: true,
      articleShape: "v3",
    });
    expect(v2).toContain(MARKER);
    expect(v3).toContain(MARKER);
  });
});

describe("resolveConsolidationPrompt — no override", () => {
  test("returns the bundled prompt with {{CUTOFF}} substituted when overridePath is null", () => {
    const result = resolveConsolidationPrompt(null, CUTOFF, NO_CORE);
    expect(result).toContain("You are running memory consolidation");
    expect(result).toContain(CUTOFF);
    expect(result).not.toContain(CUTOFF_PLACEHOLDER);
    expect(warnCalls).toHaveLength(0);
  });
});

describe("resolveConsolidationPrompt — core-pages gate", () => {
  test("omits the core-pages section (and any placeholder residue) when the v3 gate is off", () => {
    // v2-only installs must not be told to curate a file nothing reads.
    const result = resolveConsolidationPrompt(null, CUTOFF, NO_CORE);
    expect(result).not.toContain("core-pages");
    expect(result).not.toContain(CORE_PAGES_PLACEHOLDER);
    // The section's slot collapses cleanly: §9 flows straight into the
    // separator with no stray blank lines.
    expect(result).toContain(
      "never wholesale-clear.\n\n---\n\n# What NOT to do",
    );
  });

  test("includes the core-pages section exactly once, in place, when the v3 gate is on", () => {
    const result = resolveConsolidationPrompt(null, CUTOFF, WITH_CORE);
    expect(result).toContain("## 10. Review `memory/core-pages.md`");
    expect(result.split("## 10. Review").length - 1).toBe(1);
    expect(result).not.toContain(CORE_PAGES_PLACEHOLDER);
    // Positioned between §9 and the don'ts, as authored.
    const sectionAt = result.indexOf("## 10. Review");
    expect(sectionAt).toBeGreaterThan(result.indexOf("## 9. Trim"));
    expect(sectionAt).toBeLessThan(result.indexOf("# What NOT to do"));
  });

  test("substitutes the placeholder in override files per the same gate", () => {
    const path = join(tmpWorkspace, "custom-prompt.md");
    writeFileSync(path, "Before\n{{CORE_PAGES_SECTION}}After {{CUTOFF}}\n");

    const withCore = resolveConsolidationPrompt(path, CUTOFF, WITH_CORE);
    expect(withCore).toContain("## 10. Review `memory/core-pages.md`");
    expect(withCore).not.toContain(CORE_PAGES_PLACEHOLDER);

    const withoutCore = resolveConsolidationPrompt(path, CUTOFF, NO_CORE);
    expect(withoutCore).toBe(`Before\nAfter ${CUTOFF}\n`);
  });
});

describe("resolveConsolidationPrompt — with override", () => {
  test("loads an absolute path verbatim and substitutes {{CUTOFF}}", () => {
    const path = join(tmpWorkspace, "custom-prompt.md");
    writeFileSync(path, "Custom prompt at {{CUTOFF}}\n");

    const result = resolveConsolidationPrompt(path, CUTOFF, NO_CORE);

    expect(result).toBe(`Custom prompt at ${CUTOFF}\n`);
    expect(warnCalls).toHaveLength(0);
  });

  test("resolves a relative path against the workspace dir", () => {
    writeFileSync(
      join(tmpWorkspace, "custom-prompt.md"),
      "Workspace-relative {{CUTOFF}}\n",
    );

    const result = resolveConsolidationPrompt(
      "custom-prompt.md",
      CUTOFF,
      NO_CORE,
    );

    expect(result).toBe(`Workspace-relative ${CUTOFF}\n`);
    expect(warnCalls).toHaveLength(0);
  });

  test("expands a leading ~/ to the home directory", () => {
    const filename = `.vellum-prompt-test-${process.pid}.md`;
    const path = join(homedir(), filename);
    writeFileSync(path, "Home dir {{CUTOFF}}\n");
    try {
      const result = resolveConsolidationPrompt(
        `~/${filename}`,
        CUTOFF,
        NO_CORE,
      );
      expect(result).toBe(`Home dir ${CUTOFF}\n`);
      expect(warnCalls).toHaveLength(0);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("returns the file body verbatim when {{CUTOFF}} is absent", () => {
    const body = "No placeholder here. Just a plain prompt.\n";
    writeFileSync(join(tmpWorkspace, "no-placeholder.md"), body);

    const result = resolveConsolidationPrompt(
      "no-placeholder.md",
      CUTOFF,
      NO_CORE,
    );

    expect(result).toBe(body);
    expect(warnCalls).toHaveLength(0);
  });

  test("substitutes every {{CUTOFF}} occurrence (replaceAll, not replace)", () => {
    writeFileSync(
      join(tmpWorkspace, "custom-prompt.md"),
      "{{CUTOFF}} ... {{CUTOFF}} ... {{CUTOFF}}",
    );

    const result = resolveConsolidationPrompt(
      "custom-prompt.md",
      CUTOFF,
      NO_CORE,
    );

    expect(result).toBe(`${CUTOFF} ... ${CUTOFF} ... ${CUTOFF}`);
    expect(result).not.toContain(CUTOFF_PLACEHOLDER);
  });

  test("strips the legacy {{PROC_TO_SKILLS_SECTION}} placeholder from a copied override", () => {
    writeFileSync(
      join(tmpWorkspace, "legacy-prompt.md"),
      "Before {{PROC_TO_SKILLS_SECTION}} after, at {{CUTOFF}}",
    );

    const result = resolveConsolidationPrompt(
      "legacy-prompt.md",
      CUTOFF,
      NO_CORE,
    );

    expect(result).toBe(`Before  after, at ${CUTOFF}`);
    expect(result).not.toContain("{{PROC_TO_SKILLS_SECTION}}");
  });
});

describe("resolveConsolidationPrompt — failure modes", () => {
  test("falls back to bundled prompt and logs a warning when the file is missing", () => {
    const result = resolveConsolidationPrompt(
      "/this/path/does/not/exist.md",
      CUTOFF,
      NO_CORE,
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

    const result = resolveConsolidationPrompt(path, CUTOFF, NO_CORE);

    expect(result).toBe(bundledPrompt());
    expect(warnCalls).toHaveLength(1);
    const data = warnCalls[0].data as Record<string, unknown>;
    expect(data.reason).toBe("empty_override");
  });

  test("falls back to bundled prompt when the file is whitespace-only", () => {
    const path = join(tmpWorkspace, "empty.md");
    writeFileSync(path, "   \n\n\t\n");

    const result = resolveConsolidationPrompt(path, CUTOFF, NO_CORE);

    expect(result).toBe(bundledPrompt());
    expect(warnCalls).toHaveLength(1);
    const data = warnCalls[0].data as Record<string, unknown>;
    expect(data.reason).toBe("empty_override");
  });

  test("falls back to bundled prompt when the override exceeds the size limit", () => {
    const path = join(tmpWorkspace, "huge.md");
    // 1 MiB + 1 byte — just over the cap so we don't waste test memory.
    writeFileSync(path, Buffer.alloc(1 * 1024 * 1024 + 1, 0x61));

    const result = resolveConsolidationPrompt(path, CUTOFF, NO_CORE);

    expect(result).toBe(bundledPrompt());
    expect(warnCalls).toHaveLength(1);
    const data = warnCalls[0].data as Record<string, unknown>;
    expect(data.reason).toBe("oversized_override");
    expect(data.size).toBe(1 * 1024 * 1024 + 1);
  });

  test("falls back to bundled prompt when the override is a symlink", () => {
    const target = join(tmpWorkspace, "custom-prompt.md");
    writeFileSync(target, "real prompt body\n");
    const link = join(tmpWorkspace, "link.md");
    symlinkSync(target, link);

    const result = resolveConsolidationPrompt(link, CUTOFF, NO_CORE);

    expect(result).toBe(bundledPrompt());
    expect(warnCalls).toHaveLength(1);
    const data = warnCalls[0].data as Record<string, unknown>;
    expect(data.reason).toBe("not_regular_file");
  });

  test("falls back to bundled prompt when the override is a FIFO", () => {
    const fifoPath = join(tmpWorkspace, "fifo");
    try {
      execFileSync("mkfifo", [fifoPath]);
    } catch {
      // mkfifo unavailable on this platform — skip without failing.
      return;
    }

    const result = resolveConsolidationPrompt(fifoPath, CUTOFF, NO_CORE);

    expect(result).toBe(bundledPrompt());
    expect(warnCalls).toHaveLength(1);
    const data = warnCalls[0].data as Record<string, unknown>;
    expect(data.reason).toBe("not_regular_file");
  });
});
