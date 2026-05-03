/**
 * Tests for `readMemoryV2StaticContent` — the loader that powers the
 * `memory-v2-static` user-message auto-injection. Mirrors the coverage that
 * lived in the deprecated `system-prompt-memory-v2.test.ts`:
 *   - Returns null when the v2 flag is off.
 *   - Returns null when `config.memory.v2.enabled` is off.
 *   - Reads the four files in canonical order and joins them under headings.
 *   - Skips empty / missing files.
 *   - Returns null when every file is empty or missing.
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
const realLogger = require("../../../util/logger.js");
mock.module("../../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

let configMemoryV2Enabled = true;

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({}),
  loadConfig: () => ({
    memory: { v2: { enabled: configMemoryV2Enabled } },
  }),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

const { _setOverridesForTesting } =
  await import("../../../config/assistant-feature-flags.js");
const { readMemoryV2StaticContent } = await import("../static-context.js");

const MEMORY_FILES = [
  "essentials.md",
  "threads.md",
  "recent.md",
  "buffer.md",
] as const;

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

describe("readMemoryV2StaticContent", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    configMemoryV2Enabled = true;
    _setOverridesForTesting({ "memory-v2-enabled": true });
  });

  afterEach(() => {
    cleanupMemoryDir();
    _setOverridesForTesting({});
  });

  test("returns null when the feature flag is off", () => {
    _setOverridesForTesting({ "memory-v2-enabled": false });
    for (const file of MEMORY_FILES) writeMemoryFile(file, `Content ${file}`);
    expect(readMemoryV2StaticContent()).toBeNull();
  });

  test("returns null when config.memory.v2.enabled is off", () => {
    configMemoryV2Enabled = false;
    for (const file of MEMORY_FILES) writeMemoryFile(file, `Content ${file}`);
    expect(readMemoryV2StaticContent()).toBeNull();
  });

  test("returns headed sections in canonical order when all files have content", () => {
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

    const result = readMemoryV2StaticContent();
    expect(result).not.toBeNull();
    const text = result!;

    expect(text).toContain("## Essentials");
    expect(text).toContain("## Threads");
    expect(text).toContain("## Recent");
    expect(text).toContain("## Buffer");
    expect(text).toContain("Alice prefers dark mode.");
    expect(text).toContain(
      "Bob mentioned a pager rotation conflict on Friday.",
    );

    expect(text.indexOf("## Essentials")).toBeLessThan(
      text.indexOf("## Threads"),
    );
    expect(text.indexOf("## Threads")).toBeLessThan(text.indexOf("## Recent"));
    expect(text.indexOf("## Recent")).toBeLessThan(text.indexOf("## Buffer"));
  });

  test("omits empty files but keeps populated ones", () => {
    writeMemoryFile("essentials.md", "Alice prefers VS Code.");
    writeMemoryFile("threads.md", "");
    writeMemoryFile("recent.md", "Recent topic: GraphQL pagination.");
    writeMemoryFile("buffer.md", "");

    const text = readMemoryV2StaticContent();
    expect(text).not.toBeNull();
    expect(text).toContain("## Essentials");
    expect(text).toContain("## Recent");
    expect(text).not.toContain("## Threads");
    expect(text).not.toContain("## Buffer");
  });

  test("returns null when every file is empty", () => {
    for (const file of MEMORY_FILES) writeMemoryFile(file, "");
    expect(readMemoryV2StaticContent()).toBeNull();
  });

  test("returns null when memory directory is missing entirely", () => {
    cleanupMemoryDir();
    expect(readMemoryV2StaticContent()).toBeNull();
  });
});
