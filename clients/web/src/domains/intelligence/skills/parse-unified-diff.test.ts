import { describe, expect, test } from "bun:test";

import { parseUnifiedDiff } from "./parse-unified-diff";

/**
 * The input here is shaped like real `git show` output, because the parser's
 * whole job is to survive the parts of that format the renderer does not care
 * about (index lines, mode changes, multiple files, multiple hunks).
 */

const TWO_FILES = `diff --git a/skills/triage/SKILL.md b/skills/triage/SKILL.md
index 1a2b3c4..5d6e7f8 100644
--- a/skills/triage/SKILL.md
+++ b/skills/triage/SKILL.md
@@ -18,3 +18,4 @@
 ## Grouping
-Group the failures by file.
+Group the failures by owning team.
+See references/owners.md.
diff --git a/skills/triage/references/owners.md b/skills/triage/references/owners.md
new file mode 100644
index 0000000..9999999
--- /dev/null
+++ b/skills/triage/references/owners.md
@@ -0,0 +1,2 @@
+Platform owns the gateway.
+Assistant owns the daemon.
`;

describe("parseUnifiedDiff", () => {
  test("splits a combined diff into one entry per file", () => {
    const parsed = parseUnifiedDiff(TWO_FILES, "triage");

    expect(parsed.files.map((f) => f.path)).toEqual([
      "SKILL.md",
      "references/owners.md",
    ]);
  });

  test("strips the skill directory prefix from file paths", () => {
    const parsed = parseUnifiedDiff(TWO_FILES, "triage");

    // The path a reader sees should match the revision's `files` list, which
    // the daemon reports relative to the skill directory.
    expect(parsed.files[0]!.path).toBe("SKILL.md");
    expect(parsed.files[0]!.path).not.toContain("skills/");
  });

  test("tags each row and counts additions and removals", () => {
    const parsed = parseUnifiedDiff(TWO_FILES, "triage");

    expect(parsed.added).toBe(4);
    expect(parsed.removed).toBe(1);

    const skillMd = parsed.files[0]!;
    expect(skillMd.rows.map((r) => r.type)).toEqual([
      "ctx",
      "del",
      "add",
      "add",
    ]);
    expect(skillMd.rows[1]!.text).toBe("Group the failures by file.");
  });

  test("numbers rows from the hunk header, advancing each side separately", () => {
    const parsed = parseUnifiedDiff(TWO_FILES, "triage");
    const rows = parsed.files[0]!.rows;

    // Context occupies line 18 on both sides; the deletion consumes only an
    // old-side number, the additions only new-side ones.
    expect(rows[0]).toMatchObject({ type: "ctx", oldNo: 18, newNo: 18 });
    expect(rows[1]).toMatchObject({ type: "del", oldNo: 19 });
    expect(rows[1]!.newNo).toBeUndefined();
    expect(rows[2]).toMatchObject({ type: "add", newNo: 19 });
    expect(rows[3]).toMatchObject({ type: "add", newNo: 20 });
    expect(rows[2]!.oldNo).toBeUndefined();
  });

  test("drops file metadata that the rendered header already conveys", () => {
    const parsed = parseUnifiedDiff(TWO_FILES, "triage");
    const text = parsed.files
      .flatMap((f) => f.rows.map((r) => r.text))
      .join("\n");

    for (const noise of ["index 1a2b3c4", "new file mode", "--- ", "+++ "]) {
      expect(text).not.toContain(noise);
    }
  });

  test("keeps a separator between hunks so a gap does not read as contiguous", () => {
    const twoHunks = `diff --git a/skills/triage/SKILL.md b/skills/triage/SKILL.md
--- a/skills/triage/SKILL.md
+++ b/skills/triage/SKILL.md
@@ -1,2 +1,2 @@
-first
+FIRST
@@ -40,2 +40,2 @@
-fortieth
+FORTIETH
`;

    const rows = parseUnifiedDiff(twoHunks, "triage").files[0]!.rows;

    expect(rows.filter((r) => r.type === "meta")).toHaveLength(1);
    // The separator sits between the two hunks, never at the top.
    expect(rows[0]!.type).not.toBe("meta");
    expect(rows[2]!.type).toBe("meta");
    // Numbering restarts from the second hunk header rather than running on.
    expect(rows[4]).toMatchObject({ type: "add", newNo: 40 });
  });

  test("leaves a path alone when it is not under the expected skill directory", () => {
    const odd = `diff --git a/elsewhere/notes.md b/elsewhere/notes.md
@@ -1 +1 @@
-a
+b
`;

    expect(parseUnifiedDiff(odd, "triage").files[0]!.path).toBe(
      "elsewhere/notes.md",
    );
  });

  test("keeps content lines that look like file headers", () => {
    // A skill script holding SQL or Lua comments: removing `-- old note`
    // emits `-` + `-- old note` = `--- old note`, which is indistinguishable
    // from a `--- a/path` header by prefix alone. Dropping it would both hide
    // the change and, since a dropped row never advances its side's counter,
    // shift every line number after it.
    const looksLikeHeaders = `diff --git a/skills/triage/scripts/q.sql b/skills/triage/scripts/q.sql
index ccc3333..ddd4444 100644
--- a/skills/triage/scripts/q.sql
+++ b/skills/triage/scripts/q.sql
@@ -1,4 +1,4 @@
 SELECT 1;
--- old note
+++ new note
 SELECT 2;
`;

    const parsed = parseUnifiedDiff(looksLikeHeaders, "triage");
    const rows = parsed.files[0]!.rows;

    expect(parsed.added).toBe(1);
    expect(parsed.removed).toBe(1);
    expect(rows.map((r) => r.type)).toEqual(["ctx", "del", "add", "ctx"]);
    expect(rows[1]!.text).toBe("-- old note");
    expect(rows[2]!.text).toBe("++ new note");
    // The trailing context keeps its true position on both sides.
    expect(rows[3]).toMatchObject({ type: "ctx", oldNo: 3, newNo: 3 });
  });

  test("drops the no-newline marker wherever it appears", () => {
    const noNewline = `diff --git a/skills/triage/SKILL.md b/skills/triage/SKILL.md
@@ -1,2 +1,2 @@
-first
\\ No newline at end of file
+FIRST
`;

    const rows = parseUnifiedDiff(noNewline, "triage").files[0]!.rows;

    expect(rows.map((r) => r.type)).toEqual(["del", "add"]);
  });

  test("recovers a path containing spaces", () => {
    // Verbatim `git show` output for a tracked file named `my file.md`. Git
    // does not quote a space, and appends a tab to the ---/+++ headers, so
    // splitting the `diff --git` line on whitespace yields `file.md`.
    const spaced = `diff --git a/skills/triage/my file.md b/skills/triage/my file.md
index 7898192..6178079 100644
--- a/skills/triage/my file.md\t
+++ b/skills/triage/my file.md\t
@@ -1 +1 @@
-a
+b
`;

    const parsed = parseUnifiedDiff(spaced, "triage");

    expect(parsed.files[0]!.path).toBe("my file.md");
    expect(parsed.files[0]!.rows).toHaveLength(2);
  });

  test("uses the surviving side's path when a file is deleted", () => {
    const deleted = `diff --git a/skills/triage/gone.md b/skills/triage/gone.md
deleted file mode 100644
index 7898192..0000000
--- a/skills/triage/gone.md
+++ /dev/null
@@ -1 +0,0 @@
-a
`;

    const parsed = parseUnifiedDiff(deleted, "triage");

    // `/dev/null` must never become the displayed name.
    expect(parsed.files[0]!.path).toBe("gone.md");
    expect(parsed.removed).toBe(1);
  });

  test("returns no files for an empty diff instead of throwing", () => {
    expect(parseUnifiedDiff("", "triage")).toEqual({
      files: [],
      added: 0,
      removed: 0,
    });
  });
});
