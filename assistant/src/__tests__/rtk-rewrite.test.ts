import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __setRtkAvailableForTest,
  rewriteForRtk,
} from "../tools/shared/rtk-rewrite.js";

// Most tests force availability via __setRtkAvailableForTest, so the
// PATH value is irrelevant — pass a stub string consistently.
const PATH_STUB = "/usr/bin:/bin";
const rewrite = (cmd: string): string => rewriteForRtk(cmd, PATH_STUB);

describe("rewriteForRtk", () => {
  beforeEach(() => {
    __setRtkAvailableForTest(true);
  });

  afterEach(() => {
    __setRtkAvailableForTest(null);
  });

  describe("supported commands", () => {
    test("rewrites bare git status", () => {
      expect(rewrite("git status")).toBe("rtk git status");
    });

    test("rewrites pytest with flags", () => {
      expect(rewrite("pytest -v --tb=short")).toBe("rtk pytest -v --tb=short");
    });

    test("rewrites ls with flags", () => {
      expect(rewrite("ls -la")).toBe("rtk ls -la");
    });

    test("rewrites tsc --noEmit", () => {
      expect(rewrite("tsc --noEmit")).toBe("rtk tsc --noEmit");
    });

    test("rewrites cargo test", () => {
      expect(rewrite("cargo test --release")).toBe("rtk cargo test --release");
    });
  });

  describe("prefix preservation", () => {
    test("preserves cd && chain", () => {
      expect(rewrite("cd /tmp && pytest -v")).toBe("cd /tmp && rtk pytest -v");
    });

    test("preserves env-var assignment", () => {
      expect(rewrite("FOO=bar pytest")).toBe("FOO=bar rtk pytest");
    });

    test("preserves stacked prefixes without sudo", () => {
      expect(rewrite("cd /x && FOO=bar git log")).toBe(
        "cd /x && FOO=bar rtk git log",
      );
    });

    test("handles cd with a double-quoted path containing spaces", () => {
      expect(rewrite('cd "/path with spaces" && git status')).toBe(
        'cd "/path with spaces" && rtk git status',
      );
    });

    test("handles cd with a single-quoted path containing spaces", () => {
      expect(rewrite("cd '/my dir' && pytest -v")).toBe(
        "cd '/my dir' && rtk pytest -v",
      );
    });
  });

  describe("pipes", () => {
    test("rewrites head of a pipeline, leaves tail intact", () => {
      expect(rewrite("git status | less")).toBe("rtk git status | less");
    });

    test("leaves pipelines whose head isn't rtk-eligible", () => {
      expect(rewrite("cat foo.txt | grep bar")).toBe("cat foo.txt | grep bar");
    });

    test("ignores `|` inside double-quoted arguments", () => {
      // The `|` inside the grep pattern must not truncate the head
      // segment — otherwise the classifier sees a broken token and
      // decides the result by accident. Quote-aware detection picks
      // the outer pipe.
      expect(rewrite('git log --grep="a|b" | less')).toBe(
        'rtk git log --grep="a|b" | less',
      );
    });

    test("ignores `|` inside single-quoted arguments", () => {
      expect(rewrite("grep -E 'foo|bar' file.txt")).toBe(
        "rtk grep -E 'foo|bar' file.txt",
      );
    });
  });

  describe("non-rewritten cases", () => {
    test("passes through unknown head commands", () => {
      expect(rewrite("cat file.log")).toBe("cat file.log");
      expect(rewrite("bash -c 'echo hi'")).toBe("bash -c 'echo hi'");
    });

    test("does not match executable names inside arguments", () => {
      // `cat tsc.log` head is `cat`, not `tsc`.
      expect(rewrite("cat tsc.log")).toBe("cat tsc.log");
      // `echo "git status"` head is `echo`; the quoted content must not
      // trigger a rewrite.
      expect(rewrite('echo "git status"')).toBe('echo "git status"');
    });

    test("does not rewrite bash builtins (test, read)", () => {
      // `test` and `read` are shell builtins — rewriting to
      // `rtk test -f foo` would dispatch to rtk's test-runner
      // subcommand and misinterpret the flags.
      expect(rewrite("test -f /tmp/foo")).toBe("test -f /tmp/foo");
      expect(rewrite("read var")).toBe("read var");
    });

    test("does not match against empty / whitespace-only input", () => {
      expect(rewrite("")).toBe("");
      expect(rewrite("   ")).toBe("   ");
    });

    test("does not rewrite when only prefixes are present", () => {
      expect(rewrite("cd /tmp && ")).toBe("cd /tmp && ");
    });
  });

  describe("PATH-visibility guard", () => {
    test("skips rewrite when command scopes PATH in the prefix", () => {
      // We can't know whether rtk is reachable via the overridden PATH,
      // so leaving the command alone is safer than injecting `rtk`.
      expect(rewrite("PATH=/usr/bin git status")).toBe(
        "PATH=/usr/bin git status",
      );
      expect(rewrite("cd /tmp && PATH=/opt/bin pytest -v")).toBe(
        "cd /tmp && PATH=/opt/bin pytest -v",
      );
    });

    test("skips rewrite when the command runs under sudo", () => {
      // sudo uses `secure_path`, which typically omits user-level bins
      // where rtk may live — injecting rtk would turn a working
      // privileged command into `rtk: command not found`.
      expect(rewrite("sudo docker ps")).toBe("sudo docker ps");
      expect(rewrite("cd /x && FOO=bar sudo git log")).toBe(
        "cd /x && FOO=bar sudo git log",
      );
    });

    test("still rewrites when a non-PATH env var is scoped", () => {
      expect(rewrite("CI=1 pytest -v")).toBe("CI=1 rtk pytest -v");
    });
  });

  describe("rtk-availability fallback", () => {
    test("passes through when rtk is not on PATH", () => {
      __setRtkAvailableForTest(false);
      expect(rewrite("git status")).toBe("git status");
      expect(rewrite("pytest -v")).toBe("pytest -v");
    });

    test("probes the caller-supplied PATH, not process.env.PATH", () => {
      // Clear test override so the real probe runs against the
      // PATH we pass in. An empty PATH must fail the probe even if
      // process.env.PATH on the test machine has rtk.
      __setRtkAvailableForTest(null);
      expect(rewriteForRtk("git status", "")).toBe("git status");
      expect(rewriteForRtk("git status", "/nonexistent-path-xyz")).toBe(
        "git status",
      );
    });
  });
});
