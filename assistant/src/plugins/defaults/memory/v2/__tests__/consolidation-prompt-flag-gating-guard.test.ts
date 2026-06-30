/**
 * Guard: the DEFAULT consolidation prompt must not leak flag-gated feature
 * content to installs that don't have the feature enabled.
 *
 * Why this exists: the consolidation prompt ships to every assistant with no
 * `memory.v2.consolidation_prompt_path` override, and it is processed without
 * any flag check at run time — so flag-gated instructions added to the shared
 * template reach the entire default population at their next consolidation.
 * That happened once: the memory-v3 `core-pages.md` curation step landed
 * inline and instructed v2-only installs to curate a file nothing on their
 * install reads, under premises ("kept in reach every turn", "the hot set")
 * that are false without the v3 lanes. This is the same leak class
 * `workspace-release-notes-feature-flag-guard.test.ts` blocks for UPDATES.md,
 * via a path that guard doesn't cover.
 *
 * The rule this enforces: flag-gated content enters the template only via a
 * `{{...}}` placeholder substituted by `renderConsolidationPrompt` under a
 * `ConsolidationPromptOptions` gate. When you add a gated section, register
 * it in GATED_SECTIONS below so the guard covers it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  CONSOLIDATION_PROMPT_V3,
  CORE_PAGES_CONSOLIDATION_SECTION,
  renderConsolidationPrompt,
} from "../prompts/consolidation.js";

type Registry = {
  flags: Array<{
    key: string;
    scope: string;
    defaultEnabled: boolean;
  }>;
};

/**
 * Every flag-gated section of the consolidation prompt, with a short
 * distinctive marker that would survive light rewording of the section body.
 * The guard asserts neither appears in the all-gates-off rendering.
 */
const GATED_SECTIONS: Array<{
  name: string;
  section: string;
  marker: string;
}> = [
  {
    name: "memory-v3 core-pages curation (gate: memory-v3-shadow|live)",
    section: CORE_PAGES_CONSOLIDATION_SECTION,
    marker: "core-pages",
  },
];

/** All `ConsolidationPromptOptions` gates forced off — the v2-only rendering. */
const ALL_GATES_OFF = {
  includeCorePagesSection: false,
  articleShape: "v2" as const,
};

/**
 * Phrases distinctive to the v3 article-shape template. The all-gates-off
 * rendering must contain none of them — the v3 shape drops the `summary:`
 * field that v2 injection depends on, so leaking it to a v2 install corrupts
 * the corpus the install actually serves prompts from.
 */
const V3_SHAPE_MARKERS = [
  "The lead IS the card",
  "status: cc-draft",
  "kind: index",
];

// Registry helpers mirror workspace-release-notes-feature-flag-guard.test.ts.
function loadDefaultDisabledAssistantFlagKeys(): string[] {
  const registryPath = join(
    process.cwd(),
    "..",
    "meta",
    "feature-flags",
    "feature-flag-registry.json",
  );
  const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as Registry;
  return registry.flags
    .filter((flag) => flag.scope === "assistant" && !flag.defaultEnabled)
    .map((flag) => flag.key)
    .sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function featureFlagKeyPattern(key: string): RegExp {
  const escaped = escapeRegExp(key);
  if (key.includes("-")) {
    return new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:$|[^a-z0-9-])`, "i");
  }
  return new RegExp("[`'\"]" + escaped + "[`'\"]", "i");
}

describe("default consolidation prompt flag-gating guard", () => {
  const rendered = renderConsolidationPrompt("Jan 1, 12:00 AM", ALL_GATES_OFF);

  test("leaves no unsubstituted {{...}} placeholders", () => {
    // A placeholder added to the template but not wired into
    // renderConsolidationPrompt's substitutions would ship raw braces to
    // every default-prompt install.
    const residue = rendered.match(/\{\{[A-Z0-9_]+\}\}/g) ?? [];
    expect(
      residue,
      "Unsubstituted placeholder(s) in the default consolidation prompt — " +
        "wire them through renderConsolidationPrompt and gate them via " +
        "ConsolidationPromptOptions.",
    ).toEqual([]);
  });

  test("contains no flag-gated section content when all gates are off", () => {
    const violations: string[] = [];
    for (const { name, section, marker } of GATED_SECTIONS) {
      if (rendered.includes(section)) {
        violations.push(`${name}: full section text present`);
      }
      if (rendered.includes(marker)) {
        violations.push(`${name}: marker "${marker}" present`);
      }
    }

    const message = [
      "The default consolidation prompt reaches every install with no prompt",
      "override, regardless of feature flags. Flag-gated feature instructions",
      "must enter via a {{...}} placeholder substituted under a",
      "ConsolidationPromptOptions gate (see CORE_PAGES_PLACEHOLDER for the",
      "pattern) — never inline in CONSOLIDATION_PROMPT.",
      "",
      "Violations:",
      ...violations.map((violation) => `  - ${violation}`),
    ].join("\n");
    expect(violations, message).toEqual([]);
  });

  test("references no default-disabled assistant feature flags", () => {
    const violations: string[] = [];
    for (const key of loadDefaultDisabledAssistantFlagKeys()) {
      if (featureFlagKeyPattern(key).test(rendered)) {
        violations.push(`references default-disabled flag "${key}"`);
      }
    }
    expect(
      violations,
      "The default consolidation prompt must not mention default-disabled " +
        "assistant feature flags by name.\n" +
        violations.map((violation) => `  - ${violation}`).join("\n"),
    ).toEqual([]);
  });

  test("contains no v3 article-shape content when the shape gate is v2", () => {
    const violations = V3_SHAPE_MARKERS.filter((marker) =>
      rendered.includes(marker),
    );
    expect(
      violations,
      "The v2 (all-gates-off) rendering must not teach the v3 article shape — " +
        "v2 installs depend on `summary:` fragment pages. v3-shape content " +
        "belongs only in CONSOLIDATION_PROMPT_V3, selected via " +
        "options.articleShape.\nLeaked markers: " +
        violations.join(", "),
    ).toEqual([]);
  });

  test("the v3 rendering teaches the v3 shape and drops the v2 summary requirement", () => {
    const v3 = renderConsolidationPrompt("Jan 1, 12:00 AM", {
      includeCorePagesSection: true,
      articleShape: "v3",
    });
    for (const marker of V3_SHAPE_MARKERS) {
      expect(v3).toContain(marker);
    }
    // The v3 shape must not instruct a required `summary:` field — its absence
    // is the wiki↔v2 coupling the deploy sequence is built around.
    expect(v3).not.toContain("The `summary` field is required");
    // §10 rides along under the live flag.
    expect(v3).toContain(CORE_PAGES_CONSOLIDATION_SECTION);
    // The raw template keeps all placeholders wired.
    expect(CONSOLIDATION_PROMPT_V3).toContain("{{CUTOFF}}");
    expect(CONSOLIDATION_PROMPT_V3).toContain("{{CORE_PAGES_SECTION}}");
    expect(v3.match(/\{\{[A-Z0-9_]+\}\}/g) ?? []).toEqual([]);
  });

  test("the core-pages section renders only when its own gate is on", () => {
    const on = renderConsolidationPrompt("Jan 1, 12:00 AM", {
      includeCorePagesSection: true,
      articleShape: "v3",
    });
    expect(on).toContain(CORE_PAGES_CONSOLIDATION_SECTION);
    expect(on.match(/\{\{[A-Z0-9_]+\}\}/g) ?? []).toEqual([]);

    const off = renderConsolidationPrompt("Jan 1, 12:00 AM", {
      includeCorePagesSection: false,
      articleShape: "v3",
    });
    expect(off).not.toContain(CORE_PAGES_CONSOLIDATION_SECTION);
    expect(off.match(/\{\{[A-Z0-9_]+\}\}/g) ?? []).toEqual([]);
  });
});
