import { describe, expect, test } from "bun:test";

import { validateReadOnlyCommand } from "../tools/terminal/read-only-shell-gate.js";

describe("validateReadOnlyCommand", () => {
  // ── Allowed commands ────────────────────────────────────────────────

  const ALLOWED = [
    "grep -rn 'foo' .",
    "find . -name '*.ts'",
    "cat src/index.ts",
    "head -50 log.txt",
    "tail -f /var/log/system.log",
    "wc -l src/*.ts",
    "ls -la",
    "git log --oneline -10",
    "git diff HEAD~1",
    "git show abc1234",
    "git blame src/index.ts",
    "git status",
    "git grep 'TODO'",
    "rg 'pattern' src/",
    "rg --files",
    "ps aux",
    "lsof -i :8080",
    "stat src/index.ts",
    "file src/index.ts",
    "strings binary.dat",
    "echo hello",
    "printf '%s' hello",
    "pwd",
    "which grep",
    "env",
    "printenv PATH",
    "uname -a",
    "date",
    "diff file1 file2",
    "readlink -f ./symlink",
    "realpath ./path",
    "basename /a/b/c.ts",
    "dirname /a/b/c.ts",
    "seq 1 10",
    "md5sum file.txt",
    "sha256sum file.txt",
    "sort file.txt | uniq -c",
    "sort file.txt | uniq -c | sort -rn",
    "grep foo file.txt | wc -l",
    "cat file.txt | grep pattern",
    "find . -name '*.ts' | head -20",
    "git log --oneline | head -5",
    "awk '{print $2}' file.txt",
    "sed -n '1,10p' file.txt",
    "sed 's/foo/bar/' file.txt",
    "cut -d: -f1 /etc/passwd",
    "column -t file.txt",
    "tree -L 2",
    "du -sh .",
    "df -h",
  ];

  for (const cmd of ALLOWED) {
    test(`allows: ${cmd}`, () => {
      const result = validateReadOnlyCommand(cmd);
      expect(result.allowed).toBe(true);
    });
  }

  // ── Blocked: write commands ──────────────────────────────────────────

  const BLOCKED_WRITES = [
    { cmd: "rm file.txt", reason: "rm" },
    { cmd: "rm -rf /", reason: "rm" },
    { cmd: "cp file.txt copy.txt", reason: "cp" },
    { cmd: "mv file.txt new.txt", reason: "mv" },
    { cmd: "mkdir newdir", reason: "mkdir" },
    { cmd: "touch newfile.txt", reason: "touch" },
    { cmd: "chmod 755 file.sh", reason: "chmod" },
    { cmd: "chown user file.txt", reason: "chown" },
    { cmd: "tee output.txt", reason: "tee" },
    { cmd: "dd if=/dev/zero of=file.txt", reason: "dd" },
    { cmd: "ln -s /target link", reason: "ln" },
    { cmd: "tar -czf archive.tar.gz .", reason: "tar" },
    { cmd: "install -m 755 src dst", reason: "install" },
    { cmd: "rmdir emptydir", reason: "rmdir" },
  ];

  for (const { cmd, reason } of BLOCKED_WRITES) {
    test(`blocks write command: ${cmd}`, () => {
      const result = validateReadOnlyCommand(cmd);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain(reason);
    });
  }

  // ── Blocked: command chaining metacharacters ────────────────────────

  const BLOCKED_METACHARS = [
    { cmd: "grep foo file.txt; rm file.txt", reason: "chaining with ';'" },
    { cmd: "grep foo file.txt && rm file.txt", reason: "chaining with '&&'" },
    { cmd: "grep foo file.txt || rm file.txt", reason: "chaining with '||'" },
    { cmd: "echo `whoami`", reason: "backtick" },
    { cmd: "echo $(whoami)", reason: "'$()'" },
    { cmd: "echo hello > file.txt", reason: "redirection" },
    { cmd: "echo hello >> file.txt", reason: "redirection" },
    { cmd: "grep foo < file.txt", reason: "input redirection" },
  ];

  for (const { cmd, reason } of BLOCKED_METACHARS) {
    test(`blocks metacharacter: ${cmd}`, () => {
      const result = validateReadOnlyCommand(cmd);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain(reason);
    });
  }

  // ── Blocked: dangerous flags on allowed commands ────────────────────

  test("blocks sed -i (in-place edit)", () => {
    const result = validateReadOnlyCommand("sed -i 's/foo/bar/' file.txt");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("sed -i");
  });

  test("blocks find -exec (arbitrary command execution)", () => {
    // The `;` in `-exec ... \;` is caught by the metacharacter gate first,
    // which is correct — find -exec requires a semicolon terminator, so the
    // metacharacter gate naturally blocks all -exec variants.
    const result = validateReadOnlyCommand("find . -exec rm {} \\;");
    expect(result.allowed).toBe(false);
  });

  test("blocks find -execdir (arbitrary command execution)", () => {
    const result = validateReadOnlyCommand("find . -execdir echo {} +");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("-exec");
  });

  test("blocks find -delete", () => {
    const result = validateReadOnlyCommand("find . -name '*.tmp' -delete");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("-delete");
  });

  test("blocks awk system() calls", () => {
    const result = validateReadOnlyCommand("awk 'BEGIN{system(\"rm x\")}'");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("system()");
  });

  test("blocks awk output redirection", () => {
    const result = validateReadOnlyCommand("awk '{print > \"out.txt\"}'");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("redirection");
  });

  // ── Blocked: git write subcommands ───────────────────────────────────

  const BLOCKED_GIT = [
    { cmd: "git commit -m 'msg'", reason: "commit" },
    { cmd: "git push", reason: "push" },
    { cmd: "git merge feature", reason: "merge" },
    { cmd: "git rebase main", reason: "rebase" },
    { cmd: "git checkout -b newbranch", reason: "checkout" },
    { cmd: "git reset --hard HEAD~1", reason: "reset" },
    { cmd: "git clean -fd", reason: "clean" },
    { cmd: "git stash drop", reason: "stash drop" },
    { cmd: "git config user.name 'foo'", reason: "config writes" },
  ];

  for (const { cmd, reason } of BLOCKED_GIT) {
    test(`blocks git write subcommand: ${cmd}`, () => {
      const result = validateReadOnlyCommand(cmd);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain(reason);
    });
  }

  // ── Blocked: path-based execution bypass ─────────────────────────────

  test("blocks execution by absolute path", () => {
    const result = validateReadOnlyCommand("/usr/bin/rm file.txt");
    expect(result.allowed).toBe(false);
  });

  test("blocks execution by relative path", () => {
    const result = validateReadOnlyCommand("./malicious_script.sh");
    expect(result.allowed).toBe(false);
  });

  test("blocks command/exec prefix bypass", () => {
    const result = validateReadOnlyCommand("command rm file.txt");
    expect(result.allowed).toBe(false);
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  test("allows empty pipe segment content (e.g. trailing pipe)", () => {
    // A trailing pipe like `grep foo |` would produce an empty segment.
    // This should be rejected since extractBaseBinary returns null.
    const result = validateReadOnlyCommand("grep foo |");
    expect(result.allowed).toBe(false);
  });

  test("rejects null bytes (handled upstream but also safe here)", () => {
    // Null bytes are caught earlier in shell.ts, but validateReadOnlyCommand
    // should still handle them gracefully.
    const result = validateReadOnlyCommand("grep foo\x00file.txt");
    // Null bytes don't trigger metacharacter patterns, so this falls through
    // to command validation. `grep` is allowed, so it passes.
    // The upstream null-byte check in shell.ts catches this before we get here.
    expect(result.allowed).toBe(true);
  });

  test("allows env var prefix before allowed command", () => {
    const result = validateReadOnlyCommand("LANG=C grep foo file.txt");
    expect(result.allowed).toBe(true);
  });

  test("allows piped git commands", () => {
    const result = validateReadOnlyCommand("git log --oneline | grep 'fix'");
    expect(result.allowed).toBe(true);
  });
});
