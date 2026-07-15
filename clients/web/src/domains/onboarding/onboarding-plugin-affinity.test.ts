/**
 * Tests for the deterministic plugin floor: the always-install baseline and the
 * role-keyword affinity map. The contract that matters: admin-copilot installs
 * for everyone, a founder/CEO gets marketing, an engineer gets git tooling,
 * matching is whole-token (no false fires inside words), and everything is
 * narrowed to the live catalog.
 */

import { describe, expect, test } from "bun:test";

import {
  ALWAYS_INSTALL_PLUGINS,
  pluginsForRole,
  resolveDeterministicPlugins,
} from "@/domains/onboarding/onboarding-plugin-affinity";

/** Stand-in for the full Vellum-owned onboarding catalog. */
const FULL_CATALOG = new Set([
  "admin-copilot",
  "marketing-expert",
  "git-workflow",
]);

describe("ALWAYS_INSTALL_PLUGINS", () => {
  test("admin-copilot is the universal baseline", () => {
    expect(ALWAYS_INSTALL_PLUGINS).toContain("admin-copilot");
  });
});

describe("pluginsForRole", () => {
  test("founder / CEO → marketing-expert", () => {
    expect(pluginsForRole("Founder / CEO")).toContain("marketing-expert");
  });

  test("marketing and growth roles → marketing-expert", () => {
    for (const role of [
      "Marketing Manager",
      "Growth Marketer",
      "Content Writer",
      "Head of Brand",
      "Sales Representative",
      "Account Executive",
      "Entrepreneur",
    ]) {
      expect(pluginsForRole(role)).toContain("marketing-expert");
    }
  });

  test("engineering roles → git-workflow", () => {
    for (const role of [
      "Software Engineer",
      "Senior Developer",
      "DevOps Engineer",
      "Machine Learning Engineer",
      "Backend Developer",
      "Full Stack Engineer",
      "SRE",
      "CTO",
    ]) {
      expect(pluginsForRole(role)).toContain("git-workflow");
    }
  });

  test("whole-token matching: 'dev' does not fire inside 'developer'", () => {
    // "developer" must be matched by its own keyword, never by a bare "dev".
    // Negative control: a role with neither maps to nothing.
    expect(pluginsForRole("Veterinarian")).toEqual([]);
    expect(pluginsForRole("Architect")).toEqual([]); // building architect, not software
  });

  test("non-software engineering disciplines do NOT get git-workflow", () => {
    // The bare "engineer"/"software" tokens used to over-match these.
    for (const role of [
      "Mechanical Engineer",
      "Civil Engineer",
      "Biomedical Engineer",
      "Electrical Engineer",
      "Chemical Engineer",
      "Aerospace Engineer",
    ]) {
      expect(pluginsForRole(role)).not.toContain("git-workflow");
    }
  });

  test("'software' as a qualifier on a non-eng title does not fire git-workflow", () => {
    // "Software Product Manager" must stay a PM (unmapped), not match on "software".
    expect(pluginsForRole("Software Product Manager")).toEqual([]);
  });

  test("Sales Engineer is treated as sales, not a git user", () => {
    const result = pluginsForRole("Sales Engineer");
    expect(result).toContain("marketing-expert");
    expect(result).not.toContain("git-workflow");
  });

  test("git-adjacent non-engineering roles are left to the model", () => {
    expect(pluginsForRole("Data Scientist")).toEqual([]);
    expect(pluginsForRole("Product Manager")).toEqual([]);
  });

  test("a technical founder can match both buckets", () => {
    const result = pluginsForRole("Founder and Software Engineer");
    expect(result).toContain("marketing-expert");
    expect(result).toContain("git-workflow");
  });

  test("blank role → no affinity matches", () => {
    expect(pluginsForRole("")).toEqual([]);
    expect(pluginsForRole("   ")).toEqual([]);
  });
});

describe("resolveDeterministicPlugins", () => {
  test("baseline first, then role matches, deduped", () => {
    expect(resolveDeterministicPlugins("Founder / CEO", FULL_CATALOG)).toEqual([
      "admin-copilot",
      "marketing-expert",
    ]);
  });

  test("always includes the baseline even for an unmapped role", () => {
    expect(resolveDeterministicPlugins("Teacher", FULL_CATALOG)).toEqual([
      "admin-copilot",
    ]);
  });

  test("narrows to the live catalog — absent names are dropped", () => {
    // marketing-expert not in the catalog (filtered out / not published) → skipped.
    const partial = new Set(["admin-copilot", "git-workflow"]);
    expect(resolveDeterministicPlugins("Marketing Manager", partial)).toEqual([
      "admin-copilot",
    ]);
  });

  test("empty catalog → nothing installable, even the baseline", () => {
    expect(resolveDeterministicPlugins("Founder / CEO", new Set())).toEqual([]);
  });

  test("no duplicates when a role also matches a baseline plugin", () => {
    const result = resolveDeterministicPlugins(
      "Founder and Software Engineer",
      FULL_CATALOG,
    );
    expect(result).toEqual([
      "admin-copilot",
      "marketing-expert",
      "git-workflow",
    ]);
    expect(new Set(result).size).toBe(result.length);
  });

  test("forced pick installs even when the role doesn't imply it", () => {
    // Teacher is unmapped (no role affinity), so only the baseline + forced.
    expect(
      resolveDeterministicPlugins("Teacher", FULL_CATALOG, ["git-workflow"]),
    ).toEqual(["admin-copilot", "git-workflow"]);
  });

  test("forced is narrowed to the catalog — an absent forced name is dropped", () => {
    expect(
      resolveDeterministicPlugins("Teacher", FULL_CATALOG, ["not-in-catalog"]),
    ).toEqual(["admin-copilot"]);
  });

  test("forced is deduped against baseline and role matches", () => {
    const result = resolveDeterministicPlugins(
      "Founder / CEO",
      FULL_CATALOG,
      ["marketing-expert"],
    );
    expect(result).toEqual(["admin-copilot", "marketing-expert"]);
    expect(new Set(result).size).toBe(result.length);
  });
});
