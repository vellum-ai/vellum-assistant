/**
 * Tests for the shared prompt-override loader
 * (`assistant/src/memory/prompt-override.ts`) and the memory-v3
 * `resolveSelectorPrompt` built on it. Mirrors the v2 router/consolidation
 * prompt-path suites: a configured file replaces the bundled prompt, and any
 * out-of-workspace / missing / empty / oversized / non-regular / unreadable
 * file degrades to the bundled prompt with a diagnostic warning.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  loadPromptOverride,
  MAX_PROMPT_OVERRIDE_BYTES,
  resolveOverridePath,
} from "../prompt-override.js";
import { resolveSelectorPrompt } from "../v3/pool-select.js";

const warnCalls: Array<{ data: Record<string, unknown>; msg: string }> = [];
const recordingLogger = {
  warn: (data: object, msg: string) => {
    warnCalls.push({ data: data as Record<string, unknown>, msg });
  },
};

let tmpDir: string;

beforeEach(() => {
  warnCalls.length = 0;
  tmpDir = mkdtempSync(join(tmpdir(), "prompt-override-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Load against the per-test temp dir with the recording logger. */
const load = (
  overridePath: string | null | undefined,
  label = "test prompt",
): string | null =>
  loadPromptOverride({
    overridePath,
    workspaceDir: tmpDir,
    log: recordingLogger,
    label,
  });

describe("resolveOverridePath", () => {
  // Pure resolution — workspace containment is enforced by loadPromptOverride.
  test("expands a leading ~/ to the home directory", () => {
    expect(resolveOverridePath("~/sub/x.md", tmpDir)).toBe(
      join(homedir(), "sub/x.md"),
    );
  });

  test("uses an absolute path as-is", () => {
    expect(resolveOverridePath("/abs/x.md", tmpDir)).toBe("/abs/x.md");
  });

  test("resolves a relative path under the workspace dir", () => {
    expect(resolveOverridePath("rel/x.md", tmpDir)).toBe(
      join(tmpDir, "rel/x.md"),
    );
  });
});

describe("loadPromptOverride — usable override", () => {
  test("null overridePath returns null without touching the filesystem", () => {
    expect(load(null)).toBeNull();
    expect(warnCalls).toHaveLength(0);
  });

  test("undefined overridePath (unset config field) returns null without throwing", () => {
    expect(load(undefined)).toBeNull();
    expect(warnCalls).toHaveLength(0);
  });

  test("returns an absolute-path file's contents verbatim", () => {
    const p = join(tmpDir, "abs.md");
    writeFileSync(p, "absolute body\n");
    expect(load(p)).toBe("absolute body\n");
    expect(warnCalls).toHaveLength(0);
  });

  test("resolves a relative path under the workspace dir", () => {
    writeFileSync(join(tmpDir, "rel.md"), "relative body\n");
    expect(load("rel.md")).toBe("relative body\n");
    expect(warnCalls).toHaveLength(0);
  });

  test("honors a ~/ path that resolves inside the workspace", () => {
    let wsUnderHome: string;
    try {
      wsUnderHome = mkdtempSync(join(homedir(), ".vellum-prompt-override-ws-"));
    } catch {
      // Home directory not writable on this platform — skip without failing.
      return;
    }
    try {
      writeFileSync(join(wsUnderHome, "x.md"), "home workspace body\n");
      const out = loadPromptOverride({
        overridePath: `~/${basename(wsUnderHome)}/x.md`,
        workspaceDir: wsUnderHome,
        log: recordingLogger,
        label: "test prompt",
      });
      expect(out).toBe("home workspace body\n");
      expect(warnCalls).toHaveLength(0);
    } finally {
      rmSync(wsUnderHome, { recursive: true, force: true });
    }
  });
});

describe("loadPromptOverride — workspace containment", () => {
  test("an absolute path outside the workspace is rejected", () => {
    const outside = mkdtempSync(join(tmpdir(), "prompt-override-outside-"));
    try {
      const p = join(outside, "secret.md");
      writeFileSync(p, "SENSITIVE CONTENTS\n");
      expect(load(p)).toBeNull();
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0].data.reason).toBe("outside_workspace");
      expect(warnCalls[0].data.fallback).toBe("bundled");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a relative path escaping the workspace via .. is rejected", () => {
    const name = `prompt-override-escape-${process.pid}.md`;
    const target = join(tmpDir, "..", name);
    writeFileSync(target, "escaped\n");
    try {
      expect(load(join("..", name))).toBeNull();
      expect(warnCalls[0].data.reason).toBe("outside_workspace");
    } finally {
      rmSync(target, { force: true });
    }
  });

  test("a ~/ path outside the workspace is rejected", () => {
    const filename = `.vellum-prompt-override-test-${process.pid}.md`;
    const p = join(homedir(), filename);
    writeFileSync(p, "home body\n");
    try {
      expect(load(`~/${filename}`)).toBeNull();
      expect(warnCalls[0].data.reason).toBe("outside_workspace");
    } finally {
      rmSync(p, { force: true });
    }
  });

  test("a symlinked directory pointing outside the workspace is rejected", () => {
    const outside = mkdtempSync(join(tmpdir(), "prompt-override-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "SENSITIVE CONTENTS\n");
      symlinkSync(outside, join(tmpDir, "linked-dir"));
      expect(load(join("linked-dir", "secret.md"))).toBeNull();
      expect(warnCalls[0].data.reason).toBe("outside_workspace");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("loadPromptOverride — fallback to null with a diagnostic warning", () => {
  test("missing file logs ENOENT and returns null", () => {
    expect(load(join(tmpDir, "missing.md"))).toBeNull();
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0].data.code).toBe("ENOENT");
    expect(warnCalls[0].data.fallback).toBe("bundled");
  });

  test("empty file is rejected", () => {
    const p = join(tmpDir, "empty.md");
    writeFileSync(p, "");
    expect(load(p)).toBeNull();
    expect(warnCalls[0].data.reason).toBe("empty_override");
  });

  test("whitespace-only file is rejected", () => {
    const p = join(tmpDir, "ws.md");
    writeFileSync(p, "   \n\t\n");
    expect(load(p)).toBeNull();
    expect(warnCalls[0].data.reason).toBe("empty_override");
  });

  test("oversized file is rejected with its size", () => {
    const p = join(tmpDir, "huge.md");
    // 1 MiB + 1 byte — just over the cap so we don't waste test memory.
    writeFileSync(p, Buffer.alloc(MAX_PROMPT_OVERRIDE_BYTES + 1, 0x61));
    expect(load(p)).toBeNull();
    expect(warnCalls[0].data.reason).toBe("oversized_override");
    expect(warnCalls[0].data.size).toBe(MAX_PROMPT_OVERRIDE_BYTES + 1);
  });

  test("a directory is not a regular file", () => {
    expect(load(tmpDir)).toBeNull();
    expect(warnCalls[0].data.reason).toBe("not_regular_file");
  });

  test("a symlink is not a regular file (lstat does not follow it)", () => {
    const target = join(tmpDir, "target.md");
    writeFileSync(target, "real body\n");
    const link = join(tmpDir, "link.md");
    symlinkSync(target, link);
    expect(load(link)).toBeNull();
    expect(warnCalls[0].data.reason).toBe("not_regular_file");
  });

  test("a FIFO is not a regular file", () => {
    const fifoPath = join(tmpDir, "fifo");
    try {
      execFileSync("mkfifo", [fifoPath]);
    } catch {
      // mkfifo unavailable on this platform — skip without failing.
      return;
    }
    expect(load(fifoPath)).toBeNull();
    expect(warnCalls[0].data.reason).toBe("not_regular_file");
  });

  test("the label names the prompt in the warning message", () => {
    load(join(tmpDir, "missing.md"), "router prompt");
    expect(warnCalls[0].msg).toContain("router prompt override");
  });
});

describe("resolveSelectorPrompt", () => {
  // A stable phrase from the bundled selector prompt (`SYSTEM_PROMPT`).
  const BUNDLED_PHRASE =
    "Select EVERY candidate whose content the upcoming reply would draw on";

  test("null path returns the bundled selector prompt", () => {
    expect(resolveSelectorPrompt(null, tmpDir)).toContain(BUNDLED_PHRASE);
  });

  test("a configured file replaces the bundled prompt verbatim — no placeholder substitution", () => {
    const body = "Custom selector instructions {{NOT_A_PLACEHOLDER}}\n";
    writeFileSync(join(tmpDir, "selector.md"), body);
    const out = resolveSelectorPrompt("selector.md", tmpDir);
    expect(out).toBe(body);
    expect(out).not.toContain(BUNDLED_PHRASE);
  });

  test("a missing override falls back to the bundled prompt", () => {
    expect(resolveSelectorPrompt(join(tmpDir, "nope.md"), tmpDir)).toContain(
      BUNDLED_PHRASE,
    );
  });
});
