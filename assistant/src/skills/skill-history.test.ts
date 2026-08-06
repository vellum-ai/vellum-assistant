/**
 * Tests for `skill-history.ts`, run against a REAL git repository rather than
 * a mocked git.
 *
 * The behavior worth protecting is entirely about how git actually responds to
 * a pathspec: that a commit touching 100 unrelated files still yields a diff
 * scoped to one skill, that `:(exclude)` really drops the usage stamp, and
 * that a commit whose only in-skill change was excluded disappears from the
 * list. A stubbed git would let all three regress while the tests stayed
 * green, so each test builds commits in a temp repo and reads them back.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let repoDir = "";

// The module resolves the workspace through `getWorkspaceDir()`; point it at
// the temp repository. `getWorkspaceGitService` is left real so the git
// invocations under test are the ones that ship.
mock.module("../util/platform.js", () => ({
  getWorkspaceDir: () => repoDir,
}));

import { getSkillHistory } from "./skill-history.js";

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

/** Write a file under the repo, creating parents. */
function write(relPath: string, content: string): void {
  const full = join(repoDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

function commit(message: string): void {
  git("add", "-A");
  git("commit", "--no-verify", "-m", message);
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "skill-history-"));
  git("init", "-b", "main");
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  repoDir = "";
});

describe("getSkillHistory", () => {
  test("returns one entry per update, with the diff scoped to that skill", async () => {
    write("skills/alpha/SKILL.md", "# Alpha\n\nStep one.\n");
    write("skills/beta/SKILL.md", "# Beta\n\nUnrelated.\n");
    commit("initial");

    // A batched commit, the way the workspace heartbeat writes them: this
    // skill, an unrelated skill, and a conversation file all at once.
    write("skills/alpha/SKILL.md", "# Alpha\n\nStep one, corrected.\n");
    write("skills/beta/SKILL.md", "# Beta\n\nAlso changed.\n");
    write("conversations/whatever.jsonl", "{}\n");
    commit("auto-commit: heartbeat safety net (3 files)");

    const history = await getSkillHistory("alpha");

    expect(history.skillId).toBe("alpha");
    expect(history.revisions).toHaveLength(2);
    // Newest first.
    const [latest] = history.revisions;
    expect(latest!.files).toEqual(["SKILL.md"]);
    expect(latest!.diff).toContain("Step one, corrected.");
    // The other skill and the conversation file are absent even though the
    // same commit changed them.
    expect(latest!.diff).not.toContain("Also changed.");
    expect(latest!.diff).not.toContain("conversations/");
  });

  test("combines SKILL.md and companion changes from one update into a single entry", async () => {
    write("skills/alpha/SKILL.md", "# Alpha\n");
    commit("initial");

    write("skills/alpha/SKILL.md", "# Alpha\n\nRun the script.\n");
    write("skills/alpha/scripts/export.py", "print('v1')\n");
    write("skills/alpha/references/gotchas.md", "Watch the rate limit.\n");
    commit("auto-commit: heartbeat safety net (3 files)");

    const history = await getSkillHistory("alpha");

    // One update, not three per-file entries.
    const [latest] = history.revisions;
    expect(latest!.files.sort()).toEqual([
      "SKILL.md",
      "references/gotchas.md",
      "scripts/export.py",
    ]);
    expect(latest!.diff).toContain("Run the script.");
    expect(latest!.diff).toContain("print('v1')");
    expect(latest!.diff).toContain("Watch the rate limit.");
  });

  test("a load-only commit does not appear as an update", async () => {
    write("skills/alpha/SKILL.md", "# Alpha\n");
    write(
      "skills/alpha/install-meta.json",
      JSON.stringify({ origin: "custom", lastUsedAt: "2026-08-04" }),
    );
    commit("initial");

    // The skill was loaded, so only the usage stamp moved. Roughly half of a
    // real skill's commits look like this.
    write(
      "skills/alpha/install-meta.json",
      JSON.stringify({ origin: "custom", lastUsedAt: "2026-08-05" }),
    );
    commit("auto-commit: heartbeat safety net (1 file)");

    const history = await getSkillHistory("alpha");

    // Only the creating commit counts; the stamp bump is not an update.
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0]!.files).toEqual(["SKILL.md"]);
  });

  test("a real edit alongside a stamp bump keeps the edit and drops the stamp", async () => {
    write("skills/alpha/SKILL.md", "# Alpha\n");
    write(
      "skills/alpha/install-meta.json",
      JSON.stringify({ lastUsedAt: "1" }),
    );
    commit("initial");

    write("skills/alpha/SKILL.md", "# Alpha\n\nRefined.\n");
    write(
      "skills/alpha/install-meta.json",
      JSON.stringify({ lastUsedAt: "2" }),
    );
    commit("auto-commit: heartbeat safety net (2 files)");

    const history = await getSkillHistory("alpha");

    const [latest] = history.revisions;
    expect(latest!.files).toEqual(["SKILL.md"]);
    expect(latest!.diff).toContain("Refined.");
    expect(latest!.diff).not.toContain("lastUsedAt");
  });

  test("respects the limit after filtering, not before", async () => {
    write("skills/alpha/SKILL.md", "v0\n");
    commit("initial");
    // Interleave real edits with load-only commits, so a naive
    // `--max-count=limit` would return mostly stamps.
    for (let i = 1; i <= 4; i++) {
      write(
        "skills/alpha/install-meta.json",
        JSON.stringify({ lastUsedAt: `stamp-${i}` }),
      );
      commit(`stamp ${i}`);
      write("skills/alpha/SKILL.md", `v${i}\n`);
      commit(`edit ${i}`);
    }

    const history = await getSkillHistory("alpha", { limit: 3 });

    expect(history.revisions).toHaveLength(3);
    // Every returned entry is a real edit.
    for (const revision of history.revisions) {
      expect(revision.files).toEqual(["SKILL.md"]);
    }
  });

  test("reports when older history was squashed away", async () => {
    write("skills/alpha/SKILL.md", "# Alpha\n");
    commit("Compacted workspace history (14667 commits squashed)");
    write("skills/alpha/SKILL.md", "# Alpha\n\nMore.\n");
    commit("auto-commit: heartbeat safety net (1 file)");

    const history = await getSkillHistory("alpha");

    // The caller needs this to avoid presenting the oldest entry as creation.
    expect(history.truncatedByCompaction).toBe(true);
  });

  test("an untracked skill has empty history rather than an error", async () => {
    write("skills/alpha/SKILL.md", "# Alpha\n");
    commit("initial");

    const history = await getSkillHistory("never-committed");

    expect(history.revisions).toEqual([]);
    expect(history.skillId).toBe("never-committed");
  });

  test("a repository-controlled textconv driver is never executed", async () => {
    // `.gitattributes` selects a diff driver and git config names the program
    // for it. Both are writable through ordinary workspace paths, so rendering
    // a patch must not hand control to them (ATL-1238).
    write("skills/alpha/SKILL.md", "# Alpha\n");
    write(".gitattributes", "*.md diff=evil\n");
    commit("initial");
    write("skills/alpha/SKILL.md", "# Alpha\n\nEdited.\n");
    commit("auto-commit: heartbeat safety net (1 file)");

    const sentinel = join(repoDir, "textconv-executed");
    git("config", "diff.evil.textconv", `sh -c "touch ${sentinel}; cat"`);

    const history = await getSkillHistory("alpha");

    // The driver stays unrun...
    expect(existsSync(sentinel)).toBe(false);
    // ...and the diff still renders, so the hardening did not cost the feature.
    expect(history.revisions[0]!.diff).toContain("Edited.");
  });

  // `--no-ext-diff` guards the sibling vector, `diff.<driver>.command`, but has
  // no test here: an external diff driver does not fire in this environment
  // even without the flag, so an assertion about it would pass whether or not
  // the guard were present.

  test("a traversal-shaped id is rejected before it reaches a pathspec", async () => {
    write("skills/alpha/SKILL.md", "# Alpha\n");
    commit("initial");

    await expect(getSkillHistory("../../etc")).rejects.toThrow(
      /Invalid skill id/,
    );
  });

  test("a workspace that is not a repository yields empty history, and stays not a repository", async () => {
    const bare = mkdtempSync(join(tmpdir(), "skill-history-norepo-"));
    const previous = repoDir;
    repoDir = bare;
    try {
      const history = await getSkillHistory("alpha");

      expect(history.revisions).toEqual([]);
      // The empty result is not enough on its own: reading through
      // `runReadOnlyGit` would ALSO return empty here, having quietly created
      // the repository first. This route is a GET, so the absence of the
      // write is the actual invariant.
      expect(existsSync(join(bare, ".git"))).toBe(false);
      expect(readdirSync(bare)).toEqual([]);
    } finally {
      repoDir = previous;
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
