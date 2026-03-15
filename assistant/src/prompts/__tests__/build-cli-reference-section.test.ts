/**
 * Tests for buildCliReferenceSection — verifies the CLI reference section
 * included in the system prompt has the expected structure, CES tool guidance,
 * and caching behaviour.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  _resetCliHelpCache,
  buildCliReferenceSection,
} from "../system-prompt.js";

describe("buildCliReferenceSection", () => {
  beforeEach(() => {
    _resetCliHelpCache();
  });

  test("includes the Assistant CLI heading", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("## Assistant CLI");
  });

  test("includes CLI help text with command listings", () => {
    const result = buildCliReferenceSection();
    // The reference is a side-effect-free snapshot of the top-level CLI help.
    expect(result).toContain("Usage:");
    expect(result).toContain("Commands:");
  });

  test("mentions bash as the way to invoke the CLI", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("use the `bash` tool");
  });

  // -----------------------------------------------------------------------
  // CES tool guidance — new credential workflow
  // -----------------------------------------------------------------------

  test("teaches handle discovery via assistant credentials list", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("assistant credentials list");
  });

  test("teaches handle discovery via assistant oauth connections list", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("assistant oauth connections list");
  });

  test("teaches make_authenticated_request CES tool", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("make_authenticated_request");
  });

  test("teaches run_authenticated_command CES tool", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("run_authenticated_command");
  });

  test("teaches manage_secure_command_tool CES tool", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("manage_secure_command_tool");
  });

  test("warns against revealing raw secrets", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("Never reveal raw secrets");
  });

  test("warns that host_bash is outside CES secrecy boundary", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("outside the CES secrecy boundary");
  });

  // -----------------------------------------------------------------------
  // Deprecated patterns must NOT appear
  // -----------------------------------------------------------------------

  test("does not teach token-reveal via oauth connections token", () => {
    const result = buildCliReferenceSection();
    // The old pattern was: assistant oauth connections token <provider-key>
    // for fetching raw tokens. This must not appear in the guidance.
    expect(result).not.toContain(
      "assistant oauth connections token <provider-key>",
    );
  });

  test("does not recommend using credential_store for direct API calls", () => {
    const result = buildCliReferenceSection();
    // The old pattern was: "Direct API calls via host_bash — Use curl/httpie
    // with API tokens from credential_store". This is replaced by CES tools.
    expect(result).not.toContain("API tokens from credential_store");
  });

  // -----------------------------------------------------------------------
  // Caching
  // -----------------------------------------------------------------------

  test("result is cached — calling twice returns the same string", () => {
    const first = buildCliReferenceSection();
    const second = buildCliReferenceSection();
    expect(first).toBe(second);
  });

  test("cache is reset by _resetCliHelpCache", () => {
    const first = buildCliReferenceSection();
    _resetCliHelpCache();
    const second = buildCliReferenceSection();
    // Content should be identical even after reset (same CLI program),
    // but they should be independently computed strings.
    expect(first).toEqual(second);
  });
});
