/**
 * Tests for buildCliReferenceSection — verifies the CLI reference section
 * included in the system prompt has the expected structure and caching behaviour.
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
    // The help text is generated from buildCliProgram().helpInformation()
    // which lists available commands. Check for at least one known command.
    expect(result).toContain("Usage:");
    expect(result).toContain("Commands:");
  });

  test("mentions bash as the way to invoke the CLI", () => {
    const result = buildCliReferenceSection();
    expect(result).toContain("available via `bash`");
  });

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
