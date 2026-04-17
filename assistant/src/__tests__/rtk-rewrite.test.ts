import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __setRtkAvailableForTest,
  rewriteForRtk,
} from "../tools/shared/rtk-rewrite.js";

describe("rewriteForRtk", () => {
  beforeEach(() => {
    __setRtkAvailableForTest(true);
  });

  afterEach(() => {
    __setRtkAvailableForTest(null);
  });

  describe("supported commands", () => {
    test("rewrites bare git status", () => {
      expect(rewriteForRtk("git status")).toBe("rtk git status");
    });

    test("rewrites pytest with flags", () => {
      expect(rewriteForRtk("pytest -v --tb=short")).toBe(
        "rtk pytest -v --tb=short",
      );
    });

    test("rewrites ls with flags", () => {
      expect(rewriteForRtk("ls -la")).toBe("rtk ls -la");
    });

    test("rewrites tsc --noEmit", () => {
      expect(rewriteForRtk("tsc --noEmit")).toBe("rtk tsc --noEmit");
    });

    test("rewrites cargo test", () => {
      expect(rewriteForRtk("cargo test --release")).toBe(
        "rtk cargo test --release",
      );
    });
  });

  describe("prefix preservation", () => {
    test("preserves cd && chain", () => {
      expect(rewriteForRtk("cd /tmp && pytest -v")).toBe(
        "cd /tmp && rtk pytest -v",
      );
    });

    test("preserves env-var assignment", () => {
      expect(rewriteForRtk("FOO=bar pytest")).toBe("FOO=bar rtk pytest");
    });

    test("preserves sudo", () => {
      expect(rewriteForRtk("sudo docker ps")).toBe("sudo rtk docker ps");
    });

    test("preserves stacked prefixes", () => {
      expect(rewriteForRtk("cd /x && FOO=bar sudo git log")).toBe(
        "cd /x && FOO=bar sudo rtk git log",
      );
    });
  });

  describe("pipes", () => {
    test("rewrites head of a pipeline, leaves tail intact", () => {
      expect(rewriteForRtk("git status | less")).toBe("rtk git status | less");
    });

    test("leaves pipelines whose head isn't rtk-eligible", () => {
      expect(rewriteForRtk("cat foo.txt | grep bar")).toBe(
        "cat foo.txt | grep bar",
      );
    });
  });

  describe("non-rewritten cases", () => {
    test("passes through unknown head commands", () => {
      expect(rewriteForRtk("cat file.log")).toBe("cat file.log");
      expect(rewriteForRtk("bash -c 'echo hi'")).toBe("bash -c 'echo hi'");
    });

    test("does not match executable names inside arguments", () => {
      // `cat tsc.log` head is `cat`, not `tsc`.
      expect(rewriteForRtk("cat tsc.log")).toBe("cat tsc.log");
      // `echo "git status"` head is `echo`; the quoted content must not
      // trigger a rewrite.
      expect(rewriteForRtk('echo "git status"')).toBe('echo "git status"');
    });

    test("does not match against empty / whitespace-only input", () => {
      expect(rewriteForRtk("")).toBe("");
      expect(rewriteForRtk("   ")).toBe("   ");
    });

    test("does not rewrite when only prefixes are present", () => {
      expect(rewriteForRtk("cd /tmp && ")).toBe("cd /tmp && ");
    });
  });

  describe("PATH override guard", () => {
    test("skips rewrite when command scopes PATH in the prefix", () => {
      // We can't know whether rtk is reachable via the overridden PATH,
      // so leaving the command alone is safer than injecting `rtk`.
      expect(rewriteForRtk("PATH=/usr/bin git status")).toBe(
        "PATH=/usr/bin git status",
      );
      expect(rewriteForRtk("cd /tmp && PATH=/opt/bin pytest -v")).toBe(
        "cd /tmp && PATH=/opt/bin pytest -v",
      );
    });

    test("still rewrites when a non-PATH env var is scoped", () => {
      expect(rewriteForRtk("CI=1 pytest -v")).toBe("CI=1 rtk pytest -v");
    });
  });

  describe("rtk-availability fallback", () => {
    test("passes through when rtk is not on PATH", () => {
      __setRtkAvailableForTest(false);
      expect(rewriteForRtk("git status")).toBe("git status");
      expect(rewriteForRtk("pytest -v")).toBe("pytest -v");
    });
  });
});
