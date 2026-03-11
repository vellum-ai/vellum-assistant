/**
 * Tests for buildCliReferenceSection — verifies the CLI reference section
 * included in the system prompt has the expected structure.
 *
 * The full CLI help text is no longer embedded in the prompt. Instead the
 * section provides a compact summary and directs the model to `--help`.
 */

import { describe, expect, test } from "bun:test";

import { buildCliReferenceSection } from "../system-prompt.js";

describe("buildCliReferenceSection", () => {
  test("includes the Assistant CLI heading", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("## Assistant CLI");
  });

  test("directs the model to --help for full command list", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("assistant --help");
    expect(result).toContain("assistant <command> --help");
  });

  test("mentions bash as the way to invoke the CLI", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("available via `bash`");
  });

  test("routes account and auth work through documented assistant CLI commands", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("assistant credentials");
    expect(result).toContain("assistant oauth token <service>");
    expect(result).toContain("assistant mcp auth <name>");
    expect(result).toContain("assistant platform status");
  });

  test("does not embed the full CLI help reference block", () => {
    const result = buildCliReferenceSection();
    // The old section included Usage:/Commands: in a fenced code block
    expect(result).not.toContain("Usage: assistant [options] [command]");
    expect(result).not.toContain("Commands:");
  });
});
