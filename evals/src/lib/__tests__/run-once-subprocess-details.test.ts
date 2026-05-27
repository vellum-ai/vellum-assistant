import { describe, expect, test } from "bun:test";

import { subprocessFailureDetails } from "../runner/run-once";
import { SubprocessFailedError } from "../runtime/command-runner";

describe("subprocessFailureDetails", () => {
  test("renders exit code + tailed stderr + stdout, one entry per line", () => {
    const err = new SubprocessFailedError("hatch Vellum profile p1", {
      exitCode: 125,
      stdout: "building image vellum-assistant:test\nimage built in 12s\n",
      stderr:
        "docker: Error response from daemon: ...\n" +
        "bind for 0.0.0.0:20100 failed: port is already allocated\n",
    });
    const details = subprocessFailureDetails(err);
    expect(details[0]).toBe("exit code: 125");
    expect(details).toContain("stderr (last 2 lines):");
    expect(details).toContain("  docker: Error response from daemon: ...");
    expect(details).toContain(
      "  bind for 0.0.0.0:20100 failed: port is already allocated",
    );
    expect(details).toContain("stdout (last 2 lines):");
    expect(details).toContain("  building image vellum-assistant:test");
    expect(details).toContain("  image built in 12s");
  });

  test("collapses empty streams to a single `(empty)` line so absent output is explicit", () => {
    const err = new SubprocessFailedError("setup command for profile p1", {
      exitCode: 2,
      stdout: "",
      stderr: "",
    });
    const details = subprocessFailureDetails(err);
    expect(details).toEqual([
      "exit code: 2",
      "stderr: (empty)",
      "stdout: (empty)",
    ]);
  });

  test("caps each stream at 30 lines so the runner log stays scannable", () => {
    // 50 unique stderr lines. We only want the last 30 in details.
    const stderr = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const err = new SubprocessFailedError("hatch Vellum profile p1", {
      exitCode: 1,
      stdout: "",
      stderr,
    });
    const details = subprocessFailureDetails(err);
    // Header + 30 lines + stdout: (empty).
    expect(details).toContain("stderr (last 30 lines):");
    expect(details).toContain("  line 50"); // tail
    expect(details).toContain("  line 21"); // first of the kept tail
    expect(details).not.toContain("  line 20"); // dropped
    expect(details).not.toContain("  line 1");
  });

  test("handles CRLF line endings — Windows / docker output is normalized", () => {
    const err = new SubprocessFailedError("hatch Vellum profile p1", {
      exitCode: 1,
      stdout: "",
      stderr: "line one\r\nline two\r\n",
    });
    const details = subprocessFailureDetails(err);
    expect(details).toContain("  line one");
    expect(details).toContain("  line two");
    // No stray \r anywhere in the details payload.
    for (const line of details) {
      expect(line).not.toContain("\r");
    }
  });
});
