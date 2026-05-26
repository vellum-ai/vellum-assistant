/**
 * Tests for `assistant/src/memory/v3/prompts/system-prompts.ts`.
 *
 * Covers the override-resolution precedence and fail-open fallback shared by
 * the three v3 lanes (filter / descent / gate):
 *   - no config / both seams null → bundled prompt.
 *   - inline `override` wins over `path` and bundled.
 *   - empty / whitespace-only inline override → falls through to path/bundled.
 *   - file `path` (absolute, `~/`, and workspace-relative) → file contents.
 *   - missing / empty / non-regular file → bundled.
 *
 * Uses a real temp dir for the file-path branch; no `~/.vellum/` access, no
 * network, no `mock.module`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveV3SystemPrompt } from "../prompts/system-prompts.js";

const BUNDLED = "BUNDLED DEFAULT PROMPT";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "v3-prompts-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("resolveV3SystemPrompt — no override", () => {
  test("undefined config → bundled", () => {
    expect(resolveV3SystemPrompt(BUNDLED, undefined, workspaceDir)).toBe(
      BUNDLED,
    );
  });

  test("both seams null → bundled", () => {
    expect(
      resolveV3SystemPrompt(
        BUNDLED,
        { override: null, path: null },
        workspaceDir,
      ),
    ).toBe(BUNDLED);
  });
});

describe("resolveV3SystemPrompt — inline override", () => {
  test("inline override is returned verbatim", () => {
    expect(
      resolveV3SystemPrompt(
        BUNDLED,
        { override: "INLINE PROMPT", path: null },
        workspaceDir,
      ),
    ).toBe("INLINE PROMPT");
  });

  test("inline override wins over a configured path", () => {
    const file = join(workspaceDir, "from-file.md");
    writeFileSync(file, "FROM FILE");
    expect(
      resolveV3SystemPrompt(
        BUNDLED,
        { override: "INLINE WINS", path: file },
        workspaceDir,
      ),
    ).toBe("INLINE WINS");
  });

  test("empty / whitespace inline override falls through to bundled", () => {
    expect(
      resolveV3SystemPrompt(
        BUNDLED,
        { override: "   \n  ", path: null },
        workspaceDir,
      ),
    ).toBe(BUNDLED);
  });

  test("empty inline override falls through to the configured path", () => {
    const file = join(workspaceDir, "from-file.md");
    writeFileSync(file, "FROM FILE");
    expect(
      resolveV3SystemPrompt(
        BUNDLED,
        { override: "", path: file },
        workspaceDir,
      ),
    ).toBe("FROM FILE");
  });
});

describe("resolveV3SystemPrompt — file path", () => {
  test("absolute path → file contents", () => {
    const file = join(workspaceDir, "prompt.md");
    writeFileSync(file, "ABSOLUTE FILE PROMPT");
    expect(
      resolveV3SystemPrompt(
        BUNDLED,
        { override: null, path: file },
        workspaceDir,
      ),
    ).toBe("ABSOLUTE FILE PROMPT");
  });

  test("workspace-relative path resolves under workspaceDir", () => {
    writeFileSync(join(workspaceDir, "rel.md"), "RELATIVE FILE PROMPT");
    expect(
      resolveV3SystemPrompt(
        BUNDLED,
        { override: null, path: "rel.md" },
        workspaceDir,
      ),
    ).toBe("RELATIVE FILE PROMPT");
  });

  test("missing file → bundled (fail-open)", () => {
    expect(
      resolveV3SystemPrompt(
        BUNDLED,
        { override: null, path: join(workspaceDir, "does-not-exist.md") },
        workspaceDir,
      ),
    ).toBe(BUNDLED);
  });

  test("empty file → bundled (fail-open)", () => {
    const file = join(workspaceDir, "empty.md");
    writeFileSync(file, "   \n");
    expect(
      resolveV3SystemPrompt(
        BUNDLED,
        { override: null, path: file },
        workspaceDir,
      ),
    ).toBe(BUNDLED);
  });

  test("a directory path (not a regular file) → bundled (fail-open)", () => {
    expect(
      resolveV3SystemPrompt(
        BUNDLED,
        { override: null, path: workspaceDir },
        workspaceDir,
      ),
    ).toBe(BUNDLED);
  });
});
