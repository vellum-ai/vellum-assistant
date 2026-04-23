/**
 * Tests for `getSkillRuntimePath()` and `getBundledBunPath()` in
 * `assistant/src/util/platform.ts`.
 *
 * `getSkillRuntimePath()` takes the first-party-skills root as an
 * argument so the caller can source it from whichever layer owns that
 * resolution (typically `getRepoSkillsDir()` from
 * `skills/catalog-install.ts`). `getBundledBunPath()`'s compiled-binary
 * branches (macOS `.app` Resources, next-to-binary) key off
 * `import.meta.dir.startsWith("/$bunfs/")`, so at test time only the
 * source-mode early-return is exercised here; the compiled branch is
 * covered structurally via the signing + packaging step in
 * `clients/macos/build.sh` and will be exercised end-to-end by the
 * supervisor integration test added in PR 27.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getBundledBunPath, getSkillRuntimePath } from "../util/platform.js";

let skillsRoot: string;

beforeEach(() => {
  skillsRoot = join(tmpdir(), `skill-runtime-path-test-${crypto.randomUUID()}`);
  mkdirSync(join(skillsRoot, "example-skill"), { recursive: true });
  writeFileSync(
    join(skillsRoot, "example-skill", "register.ts"),
    "export {};\n",
  );
  // A directory without a register.ts, to exercise the validation miss.
  mkdirSync(join(skillsRoot, "empty-skill"), { recursive: true });
});

afterEach(() => {
  rmSync(skillsRoot, { recursive: true, force: true });
});

describe("getSkillRuntimePath", () => {
  test("returns <root>/<skillId> when the skill has a register.ts", () => {
    const resolved = getSkillRuntimePath("example-skill", skillsRoot);
    expect(resolved).toBe(join(skillsRoot, "example-skill"));
  });

  test("returns undefined when the skill directory lacks register.ts", () => {
    expect(getSkillRuntimePath("empty-skill", skillsRoot)).toBeUndefined();
  });

  test("returns undefined for a missing skill id", () => {
    expect(getSkillRuntimePath("does-not-exist", skillsRoot)).toBeUndefined();
  });

  test("returns undefined when the first-party skills root is undefined", () => {
    expect(getSkillRuntimePath("example-skill", undefined)).toBeUndefined();
  });
});

describe("getBundledBunPath", () => {
  test("returns undefined in source mode (bundled bun only ships in compiled binaries)", () => {
    expect(getBundledBunPath()).toBeUndefined();
  });
});
