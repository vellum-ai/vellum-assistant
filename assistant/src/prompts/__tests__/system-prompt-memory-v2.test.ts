/**
 * Tests for the memory-v2 autoload block in buildSystemPrompt.
 *
 * Verifies that when the `memory-v2-enabled` feature flag is on, the four
 * top-level memory files (essentials/threads/recent/buffer) are appended to
 * the dynamic suffix in order, each wrapped in a Markdown header. With the
 * flag off, none of these files leak into the prompt — even if present.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

const noopLogger: Record<string, unknown> = new Proxy(
  {} as Record<string, unknown>,
  {
    get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
  },
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

const mockLoadedConfig: Record<string, unknown> = {};

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
    },
  }),
  loadConfig: () => mockLoadedConfig,
  loadRawConfig: () => ({}),
  saveConfig: () => {},
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

const { _setOverridesForTesting } =
  await import("../../config/assistant-feature-flags.js");
const { buildSystemPrompt, SYSTEM_PROMPT_CACHE_BOUNDARY } =
  await import("../system-prompt.js");

const MEMORY_FILES = [
  "essentials.md",
  "threads.md",
  "recent.md",
  "buffer.md",
] as const;

const ALL_HEADINGS = ["## Essentials", "## Threads", "## Recent", "## Buffer"];

function writeMemoryFile(name: string, body: string): void {
  const memoryDir = join(TEST_DIR, "memory");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, name), body);
}

function cleanupMemoryDir(): void {
  const memoryDir = join(TEST_DIR, "memory");
  if (existsSync(memoryDir))
    rmSync(memoryDir, { recursive: true, force: true });
}

function expectNoHeadings(result: string): void {
  for (const heading of ALL_HEADINGS) {
    expect(result).not.toContain(heading);
  }
}

describe("buildSystemPrompt — memory v2 autoload", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    _setOverridesForTesting({});
  });

  afterEach(() => {
    cleanupMemoryDir();
    _setOverridesForTesting({});
  });

  test("flag off: no memory headings appear even when files are populated", () => {
    _setOverridesForTesting({ "memory-v2-enabled": false });
    for (const file of MEMORY_FILES) {
      writeMemoryFile(file, `Content for ${file}`);
    }
    const result = buildSystemPrompt();
    expectNoHeadings(result);
    for (const file of MEMORY_FILES) {
      expect(result).not.toContain(`Content for ${file}`);
    }
  });

  test("flag on, all files populated: all four blocks appear in canonical order", () => {
    _setOverridesForTesting({ "memory-v2-enabled": true });
    writeMemoryFile("essentials.md", "Alice prefers dark mode.");
    writeMemoryFile("threads.md", "Open thread: ship PR-123 review.");
    writeMemoryFile(
      "recent.md",
      "Yesterday Alice asked about Postgres tuning.",
    );
    writeMemoryFile(
      "buffer.md",
      "Bob mentioned a pager rotation conflict on Friday.",
    );

    const result = buildSystemPrompt();

    expect(result).toContain("## Essentials");
    expect(result).toContain("## Threads");
    expect(result).toContain("## Recent");
    expect(result).toContain("## Buffer");

    expect(result).toContain("Alice prefers dark mode.");
    expect(result).toContain("Open thread: ship PR-123 review.");
    expect(result).toContain("Yesterday Alice asked about Postgres tuning.");
    expect(result).toContain(
      "Bob mentioned a pager rotation conflict on Friday.",
    );

    const essentialsIdx = result.indexOf("## Essentials");
    const threadsIdx = result.indexOf("## Threads");
    const recentIdx = result.indexOf("## Recent");
    const bufferIdx = result.indexOf("## Buffer");
    expect(essentialsIdx).toBeLessThan(threadsIdx);
    expect(threadsIdx).toBeLessThan(recentIdx);
    expect(recentIdx).toBeLessThan(bufferIdx);
  });

  test("flag on, files empty: blocks are omitted", () => {
    _setOverridesForTesting({ "memory-v2-enabled": true });
    for (const file of MEMORY_FILES) {
      writeMemoryFile(file, "");
    }
    expectNoHeadings(buildSystemPrompt());
  });

  test("flag on, only some files have content: only populated blocks appear", () => {
    _setOverridesForTesting({ "memory-v2-enabled": true });
    writeMemoryFile("essentials.md", "Alice prefers VS Code.");
    writeMemoryFile("threads.md", "");
    writeMemoryFile("recent.md", "Recent topic: GraphQL pagination.");
    writeMemoryFile("buffer.md", "");

    const result = buildSystemPrompt();
    expect(result).toContain("## Essentials");
    expect(result).toContain("Alice prefers VS Code.");
    expect(result).toContain("## Recent");
    expect(result).toContain("Recent topic: GraphQL pagination.");
    expect(result).not.toContain("## Threads");
    expect(result).not.toContain("## Buffer");
  });

  test("flag on, files missing entirely: section is silently skipped", () => {
    _setOverridesForTesting({ "memory-v2-enabled": true });
    cleanupMemoryDir();
    expectNoHeadings(buildSystemPrompt());
  });

  test("memory blocks live in the dynamic-suffix cache region", () => {
    _setOverridesForTesting({ "memory-v2-enabled": true });
    writeMemoryFile("essentials.md", "Alice prefers dark mode.");
    const result = buildSystemPrompt();
    const boundaryIdx = result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(boundaryIdx).toBeGreaterThan(-1);
    const staticBlock = result.slice(0, boundaryIdx);
    const dynamicBlock = result.slice(
      boundaryIdx + SYSTEM_PROMPT_CACHE_BOUNDARY.length,
    );
    expect(staticBlock).not.toContain("## Essentials");
    expect(dynamicBlock).toContain("## Essentials");
    expect(dynamicBlock).toContain("Alice prefers dark mode.");
  });
});
