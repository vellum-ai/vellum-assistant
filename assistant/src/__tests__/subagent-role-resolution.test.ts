import { describe, expect, test } from "bun:test";

import { resolveSubagentRole } from "../subagent/role-resolution.js";

describe("resolveSubagentRole", () => {
  test("an absent role runs as builder", () => {
    // A spawn that names no role has always been write-capable.
    expect(resolveSubagentRole(undefined)).toEqual({ role: "builder" });
  });

  test("a blank role is the same as naming none", () => {
    for (const raw of ["", " ", "\n\t "]) {
      expect(resolveSubagentRole(raw)).toEqual({ role: "builder" });
    }
  });

  test("the three type names pass through unchanged", () => {
    expect(resolveSubagentRole("researcher")).toEqual({ role: "researcher" });
    expect(resolveSubagentRole("builder")).toEqual({ role: "builder" });
    expect(resolveSubagentRole("advisor")).toEqual({ role: "advisor" });
  });

  test("type names are case- and whitespace-insensitive", () => {
    expect(resolveSubagentRole("  Researcher ")).toEqual({
      role: "researcher",
    });
    expect(resolveSubagentRole("ADVISOR")).toEqual({ role: "advisor" });
  });

  test("legacy read-only names resolve to researcher and report the alias", () => {
    expect(resolveSubagentRole("planner")).toEqual({
      role: "researcher",
      alias: "planner",
    });
    expect(resolveSubagentRole("Investigator")).toEqual({
      role: "researcher",
      alias: "investigator",
    });
  });

  test("legacy write-capable names resolve to builder and report the alias", () => {
    expect(resolveSubagentRole("coder")).toEqual({
      role: "builder",
      alias: "coder",
    });
    expect(resolveSubagentRole("general")).toEqual({
      role: "builder",
      alias: "general",
    });
  });

  test("an unrecognized role runs read-only with the text as persona", () => {
    // Least privilege: an invented or misspelled role must never hand out
    // write access.
    expect(resolveSubagentRole("financial journalist")).toEqual({
      role: "researcher",
      personaText: "financial journalist",
    });
    expect(resolveSubagentRole("buildr")).toEqual({
      role: "researcher",
      personaText: "buildr",
    });
  });

  test("persona text is collapsed to a single line", () => {
    const resolved = resolveSubagentRole("  staff\n  security   engineer  ");
    expect(resolved.role).toBe("researcher");
    expect(resolved.personaText).toBe("staff security engineer");
  });

  test("a sentence-length role is truncated to a persona-sized hint", () => {
    const sentence =
      "You are a meticulous senior staff engineer who reviews every change against the design document and reports every discrepancy you can find, however small.";
    const resolved = resolveSubagentRole(sentence);
    expect(resolved.role).toBe("researcher");
    expect(resolved.personaText!.length).toBeLessThanOrEqual(124);
    expect(resolved.personaText!.endsWith("...")).toBe(true);
    expect(resolved.personaText!.startsWith("You are a meticulous")).toBe(true);
  });

  test("inherited object members are not roles", () => {
    for (const raw of ["constructor", "toString", "__proto__"]) {
      const resolved = resolveSubagentRole(raw);
      expect(resolved.role).toBe("researcher");
      expect(resolved.personaText).toBe(raw);
    }
  });
});
