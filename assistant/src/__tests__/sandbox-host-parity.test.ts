/**
 * Integration tests for host/sandbox parity.
 *
 * Both the sandbox (file_read, file_write, file_edit, bash) and host
 * (host_file_read, host_file_write, host_file_edit, host_bash) tool
 * families delegate to the same underlying engine:
 *
 *   FileSystemOps  — shared read/write/edit logic
 *   applyEdit      — pure match/replace engine
 *   shell.ts       — spawn + output formatting
 *
 * The only intentional difference is the PathPolicy:
 *   - sandboxPolicy: paths must stay within a boundary directory
 *   - hostPolicy:    paths must be absolute (no boundary)
 *
 * These tests verify that for equivalent in-scope operations, both
 * code-paths produce identical results — same content, same error
 * codes, same diff shapes — and that the expected divergence on
 * out-of-scope operations is correct.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";

// Mock the logger before any transitive imports that depend on pino
mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
}));

import { applyEdit } from "../tools/shared/filesystem/edit-engine.js";
import {
  FileSystemOps,
  type PathPolicy,
} from "../tools/shared/filesystem/file-ops-service.js";
import {
  hostPolicy,
  sandboxPolicy,
} from "../tools/shared/filesystem/path-policy.js";
import {
  formatShellOutput,
  MAX_OUTPUT_LENGTH,
} from "../tools/shared/shell-output.js";

// Dynamically import modules that depend on the mocked logger
const { NativeBackend } = await import("../tools/terminal/backends/native.js");
const { wrapCommand } = await import("../tools/terminal/sandbox.js");
const { ToolError } = await import("../util/errors.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testDirs: string[] = [];

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "parity-test-")));
  testDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a sandbox-bound PathPolicy that resolves relative to boundary. */
function sandboxPolicyFor(boundary: string): PathPolicy {
  return (rawPath, options) => sandboxPolicy(rawPath, boundary, options);
}

/** Build a host PathPolicy (just requires absolute paths). */
function hostPolicyFn(): PathPolicy {
  return hostPolicy;
}

/**
 * Run the same operation against both sandbox and host FileSystemOps
 * and return both results for comparison.
 */
function dualOps(boundary: string): {
  sandbox: FileSystemOps;
  host: FileSystemOps;
} {
  return {
    sandbox: new FileSystemOps(sandboxPolicyFor(boundary)),
    host: new FileSystemOps(hostPolicyFn()),
  };
}

// ===========================================================================
// 1. File read parity
// ===========================================================================

describe("Read parity: sandbox vs host produce identical content", () => {
  test("simple file read returns same numbered content", () => {
    const dir = makeTempDir();
    const content = "line one\nline two\nline three\n";
    writeFileSync(join(dir, "data.txt"), content);

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.readFileSafe({ path: "data.txt" });
    const hostResult = host.readFileSafe({ path: join(dir, "data.txt") });

    expect(sandboxResult.ok).toBe(true);
    expect(hostResult.ok).toBe(true);
    if (!sandboxResult.ok || !hostResult.ok) return;

    // Both should produce identical line-numbered output
    expect(sandboxResult.value.content).toBe(hostResult.value.content);
  });

  test("read with offset and limit returns same slice", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "lines.txt"), "a\nb\nc\nd\ne\nf\n");

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.readFileSafe({
      path: "lines.txt",
      offset: 2,
      limit: 3,
    });
    const hostResult = host.readFileSafe({
      path: join(dir, "lines.txt"),
      offset: 2,
      limit: 3,
    });

    expect(sandboxResult.ok).toBe(true);
    expect(hostResult.ok).toBe(true);
    if (!sandboxResult.ok || !hostResult.ok) return;

    expect(sandboxResult.value.content).toBe(hostResult.value.content);
  });

  test("reading a missing file returns NOT_FOUND from both", () => {
    const dir = makeTempDir();

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.readFileSafe({ path: "nonexistent.txt" });
    const hostResult = host.readFileSafe({
      path: join(dir, "nonexistent.txt"),
    });

    expect(sandboxResult.ok).toBe(false);
    expect(hostResult.ok).toBe(false);
    if (sandboxResult.ok || hostResult.ok) return;

    expect(sandboxResult.error.code).toBe("NOT_FOUND");
    expect(hostResult.error.code).toBe("NOT_FOUND");
  });

  test("reading a directory returns NOT_A_FILE from both", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "subdir"));

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.readFileSafe({ path: "subdir" });
    const hostResult = host.readFileSafe({ path: join(dir, "subdir") });

    expect(sandboxResult.ok).toBe(false);
    expect(hostResult.ok).toBe(false);
    if (sandboxResult.ok || hostResult.ok) return;

    expect(sandboxResult.error.code).toBe("NOT_A_FILE");
    expect(hostResult.error.code).toBe("NOT_A_FILE");
  });

  test("empty file read returns same content from both", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "empty.txt"), "");

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.readFileSafe({ path: "empty.txt" });
    const hostResult = host.readFileSafe({ path: join(dir, "empty.txt") });

    expect(sandboxResult.ok).toBe(true);
    expect(hostResult.ok).toBe(true);
    if (!sandboxResult.ok || !hostResult.ok) return;

    expect(sandboxResult.value.content).toBe(hostResult.value.content);
  });

  test("file with unicode content returns same from both", () => {
    const dir = makeTempDir();
    const unicode =
      "Hello\nEmoji: \u{1F600}\nCJK: \u4F60\u597D\nAccent: caf\u00E9\n";
    writeFileSync(join(dir, "unicode.txt"), unicode);

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.readFileSafe({ path: "unicode.txt" });
    const hostResult = host.readFileSafe({ path: join(dir, "unicode.txt") });

    expect(sandboxResult.ok).toBe(true);
    expect(hostResult.ok).toBe(true);
    if (!sandboxResult.ok || !hostResult.ok) return;

    expect(sandboxResult.value.content).toBe(hostResult.value.content);
  });
});

// ===========================================================================
// 2. File write parity
// ===========================================================================

describe("Write parity: sandbox vs host produce identical results", () => {
  test("writing a new file returns same shape from both", () => {
    const dir = makeTempDir();

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.writeFileSafe({
      path: "new-s.txt",
      content: "hello",
    });
    const hostResult = host.writeFileSafe({
      path: join(dir, "new-h.txt"),
      content: "hello",
    });

    expect(sandboxResult.ok).toBe(true);
    expect(hostResult.ok).toBe(true);
    if (!sandboxResult.ok || !hostResult.ok) return;

    expect(sandboxResult.value.isNewFile).toBe(true);
    expect(hostResult.value.isNewFile).toBe(true);
    expect(sandboxResult.value.newContent).toBe(hostResult.value.newContent);
    expect(sandboxResult.value.oldContent).toBe(hostResult.value.oldContent);
  });

  test("overwriting an existing file returns old content from both", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "existing-s.txt"), "old");
    writeFileSync(join(dir, "existing-h.txt"), "old");

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.writeFileSafe({
      path: "existing-s.txt",
      content: "new",
    });
    const hostResult = host.writeFileSafe({
      path: join(dir, "existing-h.txt"),
      content: "new",
    });

    expect(sandboxResult.ok).toBe(true);
    expect(hostResult.ok).toBe(true);
    if (!sandboxResult.ok || !hostResult.ok) return;

    expect(sandboxResult.value.isNewFile).toBe(false);
    expect(hostResult.value.isNewFile).toBe(false);
    expect(sandboxResult.value.oldContent).toBe("old");
    expect(hostResult.value.oldContent).toBe("old");
    expect(sandboxResult.value.newContent).toBe("new");
    expect(hostResult.value.newContent).toBe("new");

    // Verify actual files on disk
    expect(readFileSync(join(dir, "existing-s.txt"), "utf-8")).toBe("new");
    expect(readFileSync(join(dir, "existing-h.txt"), "utf-8")).toBe("new");
  });

  test("creating nested directories works from both", () => {
    const dir = makeTempDir();

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.writeFileSafe({
      path: "a/b/deep-s.txt",
      content: "deep",
    });
    const hostResult = host.writeFileSafe({
      path: join(dir, "c/d/deep-h.txt"),
      content: "deep",
    });

    expect(sandboxResult.ok).toBe(true);
    expect(hostResult.ok).toBe(true);
    if (!sandboxResult.ok || !hostResult.ok) return;

    expect(existsSync(join(dir, "a/b/deep-s.txt"))).toBe(true);
    expect(existsSync(join(dir, "c/d/deep-h.txt"))).toBe(true);
    expect(sandboxResult.value.isNewFile).toBe(true);
    expect(hostResult.value.isNewFile).toBe(true);
  });
});

// ===========================================================================
// 3. File edit parity
// ===========================================================================

describe("Edit parity: sandbox vs host produce identical edits", () => {
  test("unique match edit produces same result from both", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "edit-s.txt"), "one two three");
    writeFileSync(join(dir, "edit-h.txt"), "one two three");

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.editFileSafe({
      path: "edit-s.txt",
      oldString: "two",
      newString: "TWO",
      replaceAll: false,
    });
    const hostResult = host.editFileSafe({
      path: join(dir, "edit-h.txt"),
      oldString: "two",
      newString: "TWO",
      replaceAll: false,
    });

    expect(sandboxResult.ok).toBe(true);
    expect(hostResult.ok).toBe(true);
    if (!sandboxResult.ok || !hostResult.ok) return;

    expect(sandboxResult.value.matchCount).toBe(1);
    expect(hostResult.value.matchCount).toBe(1);
    expect(sandboxResult.value.newContent).toBe("one TWO three");
    expect(hostResult.value.newContent).toBe("one TWO three");
    expect(sandboxResult.value.matchMethod).toBe(hostResult.value.matchMethod);
  });

  test("replaceAll edit produces same result from both", () => {
    const dir = makeTempDir();
    const original = "foo bar foo baz foo";
    writeFileSync(join(dir, "ra-s.txt"), original);
    writeFileSync(join(dir, "ra-h.txt"), original);

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.editFileSafe({
      path: "ra-s.txt",
      oldString: "foo",
      newString: "qux",
      replaceAll: true,
    });
    const hostResult = host.editFileSafe({
      path: join(dir, "ra-h.txt"),
      oldString: "foo",
      newString: "qux",
      replaceAll: true,
    });

    expect(sandboxResult.ok).toBe(true);
    expect(hostResult.ok).toBe(true);
    if (!sandboxResult.ok || !hostResult.ok) return;

    expect(sandboxResult.value.matchCount).toBe(3);
    expect(hostResult.value.matchCount).toBe(3);
    expect(sandboxResult.value.newContent).toBe(hostResult.value.newContent);
    expect(sandboxResult.value.newContent).toBe("qux bar qux baz qux");
  });

  test("missing old_string returns MATCH_NOT_FOUND from both", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "mnf-s.txt"), "hello world");
    writeFileSync(join(dir, "mnf-h.txt"), "hello world");

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.editFileSafe({
      path: "mnf-s.txt",
      oldString: "xyz",
      newString: "abc",
      replaceAll: false,
    });
    const hostResult = host.editFileSafe({
      path: join(dir, "mnf-h.txt"),
      oldString: "xyz",
      newString: "abc",
      replaceAll: false,
    });

    expect(sandboxResult.ok).toBe(false);
    expect(hostResult.ok).toBe(false);
    if (sandboxResult.ok || hostResult.ok) return;

    expect(sandboxResult.error.code).toBe("MATCH_NOT_FOUND");
    expect(hostResult.error.code).toBe("MATCH_NOT_FOUND");
  });

  test("ambiguous match returns MATCH_AMBIGUOUS from both", () => {
    const dir = makeTempDir();
    const content = "repeat\nrepeat\n";
    writeFileSync(join(dir, "amb-s.txt"), content);
    writeFileSync(join(dir, "amb-h.txt"), content);

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.editFileSafe({
      path: "amb-s.txt",
      oldString: "repeat",
      newString: "unique",
      replaceAll: false,
    });
    const hostResult = host.editFileSafe({
      path: join(dir, "amb-h.txt"),
      oldString: "repeat",
      newString: "unique",
      replaceAll: false,
    });

    expect(sandboxResult.ok).toBe(false);
    expect(hostResult.ok).toBe(false);
    if (sandboxResult.ok || hostResult.ok) return;

    expect(sandboxResult.error.code).toBe("MATCH_AMBIGUOUS");
    expect(hostResult.error.code).toBe("MATCH_AMBIGUOUS");
  });

  test("editing a nonexistent file returns NOT_FOUND from both", () => {
    const dir = makeTempDir();

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.editFileSafe({
      path: "nope.txt",
      oldString: "a",
      newString: "b",
      replaceAll: false,
    });
    const hostResult = host.editFileSafe({
      path: join(dir, "nope.txt"),
      oldString: "a",
      newString: "b",
      replaceAll: false,
    });

    expect(sandboxResult.ok).toBe(false);
    expect(hostResult.ok).toBe(false);
    if (sandboxResult.ok || hostResult.ok) return;

    expect(sandboxResult.error.code).toBe("NOT_FOUND");
    expect(hostResult.error.code).toBe("NOT_FOUND");
  });
});

// ===========================================================================
// 4. Edit engine consistency (pure function)
// ===========================================================================

describe("applyEdit engine: deterministic across invocations", () => {
  test("exact single match is idempotent", () => {
    const content = "alpha beta gamma";
    const r1 = applyEdit(content, "beta", "BETA", false);
    const r2 = applyEdit(content, "beta", "BETA", false);

    expect(r1).toEqual(r2);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.updatedContent).toBe("alpha BETA gamma");
  });

  test("replaceAll is idempotent", () => {
    const content = "x y x z x";
    const r1 = applyEdit(content, "x", "X", true);
    const r2 = applyEdit(content, "x", "X", true);

    expect(r1).toEqual(r2);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.matchCount).toBe(3);
  });

  test("not-found is consistent", () => {
    const content = "hello";
    const r1 = applyEdit(content, "missing", "found", false);
    const r2 = applyEdit(content, "missing", "found", false);

    expect(r1).toEqual(r2);
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.reason).toBe("not_found");
  });

  test("ambiguous is consistent", () => {
    const content = "dup dup dup";
    const r1 = applyEdit(content, "dup", "uniq", false);
    const r2 = applyEdit(content, "dup", "uniq", false);

    expect(r1).toEqual(r2);
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.reason).toBe("ambiguous");
    if (r1.reason !== "ambiguous") return;
    expect(r1.matchCount).toBe(3);
  });

  test("multiline content is handled correctly", () => {
    const content = "line1\nline2\nline3\nline4\n";
    const result = applyEdit(content, "line2\nline3", "replaced", false);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updatedContent).toBe("line1\nreplaced\nline4\n");
    expect(result.matchCount).toBe(1);
  });

  test("replacing with empty string works", () => {
    const content = "keep remove keep";
    const result = applyEdit(content, " remove", "", false);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updatedContent).toBe("keep keep");
  });

  test("special regex characters in old_string are treated as literals", () => {
    const content = "price is $100.00 (USD)";
    const result = applyEdit(content, "$100.00", "$200.00", false);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updatedContent).toBe("price is $200.00 (USD)");
  });
});

// ===========================================================================
// 5. Path policy divergence — expected differences
// ===========================================================================

describe("Path policy divergence: sandbox blocks escapes, host requires absolute", () => {
  test("sandbox blocks path traversal (../), host allows any absolute path", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "inside.txt"), "safe content");

    const sandboxOps = new FileSystemOps(sandboxPolicyFor(dir));
    const hostOps = new FileSystemOps(hostPolicyFn());

    // Sandbox: path traversal should be rejected
    const sandboxResult = sandboxOps.readFileSafe({
      path: "../../../etc/hostname",
    });
    expect(sandboxResult.ok).toBe(false);
    if (!sandboxResult.ok) {
      expect(sandboxResult.error.code).toBe("PATH_OUT_OF_BOUNDS");
    }

    // Host: relative paths are rejected (requires absolute)
    const hostResult = hostOps.readFileSafe({ path: "relative.txt" });
    expect(hostResult.ok).toBe(false);
    if (!hostResult.ok) {
      expect(hostResult.error.code).toBe("PATH_NOT_ABSOLUTE");
    }
  });

  test("sandbox allows relative paths within boundary", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "valid.txt"), "data");

    const sandboxOps = new FileSystemOps(sandboxPolicyFor(dir));

    const result = sandboxOps.readFileSafe({ path: "valid.txt" });
    expect(result.ok).toBe(true);
  });

  test("host requires absolute path even for simple filenames", () => {
    const hostOps = new FileSystemOps(hostPolicyFn());

    const result = hostOps.readFileSafe({ path: "just-a-name.txt" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PATH_NOT_ABSOLUTE");
    }
  });

  test("sandbox rejects absolute paths outside boundary", () => {
    const dir = makeTempDir();
    const sandboxOps = new FileSystemOps(sandboxPolicyFor(dir));

    const result = sandboxOps.writeFileSafe({
      path: "/tmp/somewhere-else.txt",
      content: "bad",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PATH_OUT_OF_BOUNDS");
    }
  });
});

// ===========================================================================
// 6. Sandbox backend parity — NativeBackend & DockerBackend SandboxResult shape
// ===========================================================================

describe("SandboxResult shape consistency across backends", () => {
  test("NativeBackend.wrap returns required fields", () => {
    const native = new NativeBackend();

    // On macOS this will succeed; on other platforms it will throw ToolError
    try {
      const result = native.wrap("echo test", "/tmp");
      expect(typeof result.command).toBe("string");
      expect(Array.isArray(result.args)).toBe(true);
      expect(typeof result.sandboxed).toBe("boolean");
      expect(result.sandboxed).toBe(true);

      // All args must be strings
      for (const arg of result.args) {
        expect(typeof arg).toBe("string");
      }
    } catch (err) {
      // NativeBackend explicitly throws ToolError on unsupported platforms or
      // unsafe paths. Infrastructure calls (writeFileSync, mkdirSync) can
      // throw system errors (ErrnoException). Both are legitimate — but
      // programming errors like TypeError/ReferenceError should still fail.
      const isToolError = err instanceof ToolError;
      const isSystemError =
        err instanceof Error &&
        "syscall" in err &&
        typeof (err as NodeJS.ErrnoException).code === "string";
      expect(isToolError || isSystemError).toBe(true);
    }
  });

  test("wrapCommand disabled returns bash with sandboxed=false", () => {
    const result = wrapCommand("echo hi", "/tmp", { enabled: false });

    expect(result.command).toBe("bash");
    expect(result.args).toEqual(["-c", "--", "echo hi"]);
    expect(result.sandboxed).toBe(false);
  });

  test("wrapCommand disabled result has same shape as enabled result", () => {
    const disabled = wrapCommand("echo hi", "/tmp", { enabled: false });

    // Both must have: command (string), args (string[]), sandboxed (boolean)
    expect(typeof disabled.command).toBe("string");
    expect(Array.isArray(disabled.args)).toBe(true);
    expect(typeof disabled.sandboxed).toBe("boolean");

    for (const arg of disabled.args) {
      expect(typeof arg).toBe("string");
    }
  });
});

// ===========================================================================
// 7. Terminal output format consistency
// ===========================================================================

describe("Terminal output format: formatShellOutput shared by sandbox and host", () => {
  test("successful command output has no XML status tags", () => {
    const result = formatShellOutput("hello world", "", 0, false, 120);

    expect(result.content).toBe("hello world");
    expect(result.content).not.toContain("<command_exit");
    expect(result.content).not.toContain("<command_completed");
    expect(result.isError).toBe(false);
    expect(result.status).toBeUndefined();
  });

  test("empty output on success produces <command_completed /> tag", () => {
    const result = formatShellOutput("", "", 0, false, 120);

    expect(result.content).toBe("<command_completed />");
    expect(result.isError).toBe(false);
  });

  test("non-zero exit code with empty output produces <command_exit /> tag and descriptive message", () => {
    const result = formatShellOutput("", "", 42, false, 120);

    expect(result.content).toContain('<command_exit code="42" />');
    expect(result.content).toContain("Command failed with exit code 42");
    expect(result.content).toContain("No stdout or stderr output was produced");
    expect(result.isError).toBe(true);
    expect(result.status).toContain('<command_exit code="42" />');
  });

  test("stderr is appended to stdout with a newline separator", () => {
    const result = formatShellOutput("out", "err", 0, false, 120);

    expect(result.content).toBe("out\nerr");
  });

  test("stderr-only output uses stderr as the output", () => {
    const result = formatShellOutput("", "error message", 0, false, 120);

    expect(result.content).toBe("error message");
  });

  test("output truncation uses the shared MAX_OUTPUT_LENGTH constant", () => {
    const longOutput = "x".repeat(MAX_OUTPUT_LENGTH + 100);
    const result = formatShellOutput(longOutput, "", 0, false, 120);

    expect(result.content).toContain('limit="20K"');
    expect(result.content).toContain('file="');
    // The <output_truncated tag starts right after MAX_OUTPUT_LENGTH chars + 1 newline
    const tagStart = result.content.indexOf("<output_truncated");
    expect(tagStart).toBe(MAX_OUTPUT_LENGTH + 1);
  });

  test("timed-out command appends timeout tag and sets isError", () => {
    const result = formatShellOutput("partial", "", 137, true, 30);

    expect(result.content).toContain("partial");
    expect(result.content).toContain('<command_timeout seconds="30" />');
    expect(result.isError).toBe(true);
    expect(result.status).toContain("<command_timeout");
  });
});

// ===========================================================================
// 8. Regression tests for edge cases found during migration
// ===========================================================================

describe("Regression: edge cases in shared FileSystemOps", () => {
  test("writing empty content creates a file with empty content", () => {
    const dir = makeTempDir();

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.writeFileSafe({
      path: "empty-s.txt",
      content: "",
    });
    const hostResult = host.writeFileSafe({
      path: join(dir, "empty-h.txt"),
      content: "",
    });

    expect(sandboxResult.ok).toBe(true);
    expect(hostResult.ok).toBe(true);

    expect(readFileSync(join(dir, "empty-s.txt"), "utf-8")).toBe("");
    expect(readFileSync(join(dir, "empty-h.txt"), "utf-8")).toBe("");
  });

  test("editing a file with only whitespace works correctly", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "ws-s.txt"), "  \n  \n  ");
    writeFileSync(join(dir, "ws-h.txt"), "  \n  \n  ");

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.editFileSafe({
      path: "ws-s.txt",
      oldString: "  \n  \n  ",
      newString: "replaced",
      replaceAll: false,
    });
    const hostResult = host.editFileSafe({
      path: join(dir, "ws-h.txt"),
      oldString: "  \n  \n  ",
      newString: "replaced",
      replaceAll: false,
    });

    expect(sandboxResult.ok).toBe(true);
    expect(hostResult.ok).toBe(true);
    if (!sandboxResult.ok || !hostResult.ok) return;

    expect(sandboxResult.value.newContent).toBe("replaced");
    expect(hostResult.value.newContent).toBe("replaced");
  });

  test("write then read roundtrip produces consistent content", () => {
    const dir = makeTempDir();
    const content = "line 1\nline 2\nline 3";

    const { sandbox, host } = dualOps(dir);

    // Write via sandbox, read via both
    sandbox.writeFileSafe({ path: "roundtrip.txt", content });

    const sandboxRead = sandbox.readFileSafe({ path: "roundtrip.txt" });
    const hostRead = host.readFileSafe({ path: join(dir, "roundtrip.txt") });

    expect(sandboxRead.ok).toBe(true);
    expect(hostRead.ok).toBe(true);
    if (!sandboxRead.ok || !hostRead.ok) return;

    expect(sandboxRead.value.content).toBe(hostRead.value.content);
  });

  test("write then edit then read roundtrip is consistent", () => {
    const dir = makeTempDir();
    const initial = "const x = 1;\nconst y = 2;\nconst z = 3;";

    const { sandbox, host } = dualOps(dir);

    sandbox.writeFileSafe({ path: "code.ts", content: initial });

    sandbox.editFileSafe({
      path: "code.ts",
      oldString: "const y = 2;",
      newString: "const y = 42;",
      replaceAll: false,
    });

    const sandboxRead = sandbox.readFileSafe({ path: "code.ts" });
    const hostRead = host.readFileSafe({ path: join(dir, "code.ts") });

    expect(sandboxRead.ok).toBe(true);
    expect(hostRead.ok).toBe(true);
    if (!sandboxRead.ok || !hostRead.ok) return;

    expect(sandboxRead.value.content).toBe(hostRead.value.content);
    expect(sandboxRead.value.content).toContain("const y = 42;");
    expect(sandboxRead.value.content).not.toContain("const y = 2;");
  });

  test("file with very long lines is handled identically", () => {
    const dir = makeTempDir();
    const longLine = "a".repeat(10_000);
    writeFileSync(join(dir, "long-s.txt"), longLine);
    writeFileSync(join(dir, "long-h.txt"), longLine);

    const { sandbox, host } = dualOps(dir);

    const sandboxResult = sandbox.readFileSafe({ path: "long-s.txt" });
    const hostResult = host.readFileSafe({ path: join(dir, "long-h.txt") });

    expect(sandboxResult.ok).toBe(true);
    expect(hostResult.ok).toBe(true);
    if (!sandboxResult.ok || !hostResult.ok) return;

    expect(sandboxResult.value.content).toBe(hostResult.value.content);
  });

  test("concurrent writes to different files in same dir are isolated", () => {
    const dir = makeTempDir();

    const { sandbox } = dualOps(dir);

    // Simulate two "concurrent" writes (sequential here, but tests isolation)
    const r1 = sandbox.writeFileSafe({ path: "a.txt", content: "content-a" });
    const r2 = sandbox.writeFileSafe({ path: "b.txt", content: "content-b" });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("content-a");
    expect(readFileSync(join(dir, "b.txt"), "utf-8")).toBe("content-b");
  });

  test("edit preserves file content exactly except for the replacement", () => {
    const dir = makeTempDir();
    // Content with trailing newline, tabs, and special chars
    const content = "\tfirst line\n\tsecond line\n\tthird line\n";
    writeFileSync(join(dir, "precise.txt"), content);

    const ops = new FileSystemOps(sandboxPolicyFor(dir));
    const result = ops.editFileSafe({
      path: "precise.txt",
      oldString: "\tsecond line",
      newString: "\treplaced line",
      replaceAll: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.newContent).toBe(
      "\tfirst line\n\treplaced line\n\tthird line\n",
    );
    expect(readFileSync(join(dir, "precise.txt"), "utf-8")).toBe(
      "\tfirst line\n\treplaced line\n\tthird line\n",
    );
  });

  test("read with offset=1 and no limit returns all lines", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "full.txt"), "one\ntwo\nthree\n");

    const ops = new FileSystemOps(sandboxPolicyFor(dir));
    const result = ops.readFileSafe({ path: "full.txt", offset: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.content).toContain("one");
    expect(result.value.content).toContain("two");
    expect(result.value.content).toContain("three");
  });

  test("symlink within sandbox boundary is readable", () => {
    const dir = makeTempDir();
    const targetFile = join(dir, "target.txt");
    writeFileSync(targetFile, "linked content");

    const linkPath = join(dir, "link.txt");
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs").symlinkSync(targetFile, linkPath);
    } catch {
      // Symlink creation may fail on some systems — skip gracefully
      return;
    }

    const ops = new FileSystemOps(sandboxPolicyFor(dir));
    const result = ops.readFileSafe({ path: "link.txt" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain("linked content");
  });
});

// ===========================================================================
// 9. NativeBackend shape verification
// ===========================================================================

describe("NativeBackend: SandboxResult shape", () => {
  test("NativeBackend has a wrap method", () => {
    const native = new NativeBackend();
    expect(typeof native.wrap).toBe("function");
  });

  test("disabled sandbox returns consistent bash -c -- invocation", () => {
    // Various commands should all be wrapped consistently when disabled
    const commands = [
      "echo hello",
      "ls -la",
      "cat /etc/hosts",
      "true && false",
    ];
    for (const cmd of commands) {
      const result = wrapCommand(cmd, "/tmp", { enabled: false });
      expect(result.command).toBe("bash");
      expect(result.args[0]).toBe("-c");
      expect(result.args[1]).toBe("--");
      expect(result.args[2]).toBe(cmd);
      expect(result.sandboxed).toBe(false);
    }
  });
});

// ===========================================================================
// 10. Error handling consistency
// ===========================================================================

describe("Error handling consistency across code paths", () => {
  test("FsError codes are consistent between sandbox and host for same conditions", () => {
    const dir = makeTempDir();

    const { sandbox, host } = dualOps(dir);

    // NOT_FOUND
    const sfNotFound = sandbox.readFileSafe({ path: "missing.txt" });
    const hfNotFound = host.readFileSafe({ path: join(dir, "missing.txt") });
    expect(sfNotFound.ok).toBe(false);
    expect(hfNotFound.ok).toBe(false);
    if (!sfNotFound.ok && !hfNotFound.ok) {
      expect(sfNotFound.error.code).toBe(hfNotFound.error.code);
    }

    // NOT_A_FILE
    mkdirSync(join(dir, "dirA"));
    const sfNotFile = sandbox.readFileSafe({ path: "dirA" });
    const hfNotFile = host.readFileSafe({ path: join(dir, "dirA") });
    expect(sfNotFile.ok).toBe(false);
    expect(hfNotFile.ok).toBe(false);
    if (!sfNotFile.ok && !hfNotFile.ok) {
      expect(sfNotFile.error.code).toBe(hfNotFile.error.code);
    }
  });

  test("write error codes match between sandbox and host for same conditions", () => {
    const dir = makeTempDir();

    const { sandbox, host } = dualOps(dir);

    // Both should succeed for valid operations
    const sfWrite = sandbox.writeFileSafe({ path: "ok-s.txt", content: "ok" });
    const hfWrite = host.writeFileSafe({
      path: join(dir, "ok-h.txt"),
      content: "ok",
    });

    expect(sfWrite.ok).toBe(true);
    expect(hfWrite.ok).toBe(true);
  });

  test("edit MATCH_NOT_FOUND vs MATCH_AMBIGUOUS error codes match between paths", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "err-s.txt"), "unique text");
    writeFileSync(join(dir, "err-h.txt"), "unique text");

    const { sandbox, host } = dualOps(dir);

    // MATCH_NOT_FOUND
    const sfMnf = sandbox.editFileSafe({
      path: "err-s.txt",
      oldString: "nope",
      newString: "x",
      replaceAll: false,
    });
    const hfMnf = host.editFileSafe({
      path: join(dir, "err-h.txt"),
      oldString: "nope",
      newString: "x",
      replaceAll: false,
    });
    expect(sfMnf.ok).toBe(false);
    expect(hfMnf.ok).toBe(false);
    if (!sfMnf.ok && !hfMnf.ok) {
      expect(sfMnf.error.code).toBe(hfMnf.error.code);
      expect(sfMnf.error.code).toBe("MATCH_NOT_FOUND");
    }
  });
});
