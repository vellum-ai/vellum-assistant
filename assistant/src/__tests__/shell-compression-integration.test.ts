import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _setOverridesForTesting,
  clearFeatureFlagOverridesCache,
} from "../config/assistant-feature-flags.js";
import { formatShellOutput } from "../tools/shared/shell-output.js";

// A large pytest-style output fixture (>2000 chars) to test compression.
const LARGE_PYTEST_OUTPUT = [
  "============================= test session starts ==============================",
  "platform linux -- Python 3.11.0, pytest-7.4.0",
  "collected 50 items",
  "",
  ...Array.from(
    { length: 50 },
    (_, i) => `tests/test_module.py::test_case_${i} PASSED`,
  ),
  "",
  "============================== 50 passed in 2.34s ==============================",
].join("\n");

describe("shell compression integration", () => {
  beforeEach(() => {
    clearFeatureFlagOverridesCache();
  });

  afterEach(() => {
    clearFeatureFlagOverridesCache();
  });

  test("flag off: large pytest output unchanged", () => {
    _setOverridesForTesting({ "shell-output-compression": false });
    const result = formatShellOutput(LARGE_PYTEST_OUTPUT, "", 0, false, 120, {
      command: "pytest -v",
    });
    // Output should contain all PASSED lines since compression is off
    expect(result.content).toContain("test_case_25 PASSED");
  });

  test("flag on: large pytest output compressed", () => {
    _setOverridesForTesting({ "shell-output-compression": true });
    const result = formatShellOutput(LARGE_PYTEST_OUTPUT, "", 0, false, 120, {
      command: "pytest -v",
    });
    // Compressed output should be shorter — PASSED lines collapsed
    expect(result.content.length).toBeLessThan(LARGE_PYTEST_OUTPUT.length);
    expect(result.content).toContain("50 passed");
  });

  test("flag on, unknown command: output unchanged", () => {
    _setOverridesForTesting({ "shell-output-compression": true });
    const stdout = "some output\n".repeat(200);
    const result = formatShellOutput(stdout, "", 0, false, 120, {
      command: "docker ps",
    });
    expect(result.content).toBe(stdout);
  });

  test("flag on, short output: output unchanged", () => {
    _setOverridesForTesting({ "shell-output-compression": true });
    const stdout = "tests/test.py::test_one PASSED\n1 passed in 0.01s";
    const result = formatShellOutput(stdout, "", 0, false, 120, {
      command: "pytest",
    });
    // Short output (<2000 chars) should not be compressed
    expect(result.content).toBe(stdout);
  });

  test("backward compat: call without options param works", () => {
    _setOverridesForTesting({ "shell-output-compression": true });
    const result = formatShellOutput("hello world", "", 0, false, 120);
    expect(result.content).toBe("hello world");
    expect(result.isError).toBe(false);
  });
});
