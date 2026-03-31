/**
 * Tests for buildCliReferenceSection — verifies the CLI reference section
 * included in the system prompt has the expected structure.
 */

import { describe, expect, test } from "bun:test";

import { buildCliReferenceSection } from "../system-prompt.js";

describe("buildCliReferenceSection", () => {
  test("includes the Assistant CLI heading", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("## Assistant CLI");
  });

  test("mentions bash as the way to invoke the CLI", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("use the `bash` tool");
  });

  test("tells the model to run assistant --help for discovery", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("assistant --help");
  });

  test("mentions assistant platform for querying platform state", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("assistant platform status");
  });

  test("does not embed the full CLI help output", () => {
    const result = buildCliReferenceSection();
    // The full help text used to be embedded; now the model should
    // discover commands by running the CLI itself.
    expect(result).not.toContain("Commands:\n");
  });
});
