import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertSuccess,
  deriveStepFromLogPath,
  formatSubprocessLogLine,
  LineBuffer,
  NodeCommandRunner,
  SubprocessFailedError,
} from "../runtime/command-runner";

describe("formatSubprocessLogLine", () => {
  test("renders the canonical `[ts] [step] glyph line` shape used by the test runner", () => {
    const line = formatSubprocessLogLine({
      ts: new Date("2026-05-23T14:42:05"),
      step: "hatch",
      status: "info",
      line: "@vellumai/cli v0.8.4",
    });
    // 11-char `[step]` slot (matches STEP_LABEL_WIDTH in progress.ts).
    // Ts is local-time so we assert the components rather than the
    // string in full — DST etc. would otherwise break the test.
    expect(line).toMatch(
      /^\[2026-05-23 \d{2}:\d{2}:\d{2}\] \[hatch\]     \u2022 @vellumai\/cli v0\.8\.4$/,
    );
  });

  test("uses the ✗ glyph for stderr / error status", () => {
    const line = formatSubprocessLogLine({
      ts: new Date("2026-05-23T14:42:05"),
      step: "hatch",
      status: "error",
      line: "docker: bind: address already in use",
    });
    expect(line).toContain("[hatch]");
    expect(line).toContain("\u2717 docker: bind: address already in use");
  });

  test("step labels longer than the pad width still align correctly", () => {
    const line = formatSubprocessLogLine({
      ts: new Date("2026-05-23T14:42:05"),
      step: "setup-12",
      status: "info",
      line: "ok",
    });
    // `[setup-12]` is 10 chars; padded to 11 with one trailing space.
    expect(line).toContain("[setup-12]  \u2022 ok");
  });
});

describe("deriveStepFromLogPath", () => {
  test.each([
    ["/abs/path/subprocess-hatch.log", "hatch"],
    [".runs/eval-1/subprocess-setup-2.log", "setup-2"],
    ["subprocess-seed.log", "seed"],
    ["something-else.log", "subprocess"],
    ["", "subprocess"],
  ])("%s → %s", (path, expected) => {
    expect(deriveStepFromLogPath(path)).toBe(expected);
  });
});

describe("LineBuffer", () => {
  test("emits one line per `\\n`, holding the trailing partial", () => {
    const buf = new LineBuffer();
    expect(buf.push("hello\nworld")).toEqual(["hello"]);
    expect(buf.push("!\n")).toEqual(["world!"]);
    expect(buf.flush()).toBeNull();
  });

  test("normalizes \\r\\n line endings to \\n", () => {
    const buf = new LineBuffer();
    expect(buf.push("hello\r\nworld\r\n")).toEqual(["hello", "world"]);
  });

  test("flush() returns the trailing partial line when EOF arrives mid-line", () => {
    const buf = new LineBuffer();
    buf.push("crashed mid-message");
    expect(buf.flush()).toBe("crashed mid-message");
    // Second flush is a no-op — buffer is drained.
    expect(buf.flush()).toBeNull();
  });

  test("ignores empty chunks", () => {
    const buf = new LineBuffer();
    expect(buf.push("")).toEqual([]);
    expect(buf.flush()).toBeNull();
  });
});

describe("SubprocessFailedError", () => {
  test("carries the description and original CommandResult", () => {
    const err = new SubprocessFailedError("hatch Vellum profile p1", {
      exitCode: 1,
      stdout: "",
      stderr: "boom",
    });
    expect(err.name).toBe("SubprocessFailedError");
    expect(err.description).toBe("hatch Vellum profile p1");
    expect(err.result.exitCode).toBe(1);
    expect(err.result.stderr).toBe("boom");
    expect(err.message).toBe("hatch Vellum profile p1 failed: boom");
  });

  test("assertSuccess throws SubprocessFailedError on non-zero exit", () => {
    const result = { exitCode: 1, stdout: "", stderr: "boom" };
    expect(() => assertSuccess(result, "do thing")).toThrow(
      SubprocessFailedError,
    );
  });

  test("assertSuccess returns nothing on success", () => {
    expect(() =>
      assertSuccess({ exitCode: 0, stdout: "ok", stderr: "" }, "do thing"),
    ).not.toThrow();
  });
});

describe("NodeCommandRunner — log tee", () => {
  test("writes per-line entries in the canonical format to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "command-runner-test-"));
    try {
      const logPath = join(dir, "subprocess-hatch.log");
      const runner = new NodeCommandRunner();
      const result = await runner.run(
        "/bin/sh",
        ["-c", "echo first; echo second 1>&2; echo third"],
        {
          logPath,
          logStep: "hatch",
          now: () => new Date("2026-05-23T14:42:05"),
        },
      );
      expect(result.exitCode).toBe(0);
      // Give the best-effort writeFile time to flush. Microtask is
      // enough because we awaited the spawn close already.
      await new Promise((r) => setTimeout(r, 10));
      const log = await readFile(logPath, "utf8");
      const lines = log.split("\n").filter((l) => l.length > 0);
      // 3 lines total (2 stdout, 1 stderr). The exact ts/step layout
      // is asserted by the formatSubprocessLogLine test above; here
      // we just verify the file format wiring.
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(line).toMatch(
          /^\[2026-05-23 \d{2}:\d{2}:\d{2}\] \[hatch\]\s+[\u2022\u2717]\s.+$/,
        );
      }
      // stderr line uses ✗; stdout lines use •.
      expect(lines.filter((l) => l.includes("\u2717"))).toHaveLength(1);
      expect(lines.filter((l) => l.includes("\u2022"))).toHaveLength(2);
      // Content preserved.
      expect(log).toContain("first");
      expect(log).toContain("second");
      expect(log).toContain("third");
      // No legacy `[STDOUT]` / `[STDERR]` prefixes.
      expect(log).not.toContain("[STDOUT]");
      expect(log).not.toContain("[STDERR]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("derives the step label from logPath when logStep is omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "command-runner-test-"));
    try {
      const logPath = join(dir, "subprocess-setup-3.log");
      const runner = new NodeCommandRunner();
      await runner.run("/bin/sh", ["-c", "echo ok"], {
        logPath,
        now: () => new Date("2026-05-23T14:42:05"),
      });
      await new Promise((r) => setTimeout(r, 10));
      const log = await readFile(logPath, "utf8");
      expect(log).toContain("[setup-3]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("flushes a trailing partial line written without a final newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "command-runner-test-"));
    try {
      const logPath = join(dir, "subprocess-hatch.log");
      const runner = new NodeCommandRunner();
      // printf with no trailing newline — the child crashed mid-write.
      await runner.run("/bin/sh", ["-c", "printf trailing"], {
        logPath,
        logStep: "hatch",
        now: () => new Date("2026-05-23T14:42:05"),
      });
      await new Promise((r) => setTimeout(r, 10));
      const log = await readFile(logPath, "utf8");
      expect(log).toContain("trailing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
