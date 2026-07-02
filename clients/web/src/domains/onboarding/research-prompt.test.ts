/**
 * Tests for the research prompt's capability injection.
 *
 * The capabilities block is what makes the assistant aware of marketplace
 * plugins (e.g. marketing-expert) during onboarding research. These pin that it
 * only appears when a catalog is passed (back-compat for the route's fallback
 * kickoff), stays compact under a growing catalog, and instructs the model to
 * return a top-level `plugins` install list.
 */

import { describe, expect, test } from "bun:test";

import {
  buildResearchPrompt,
  type AvailableCapability,
} from "@/domains/onboarding/research-prompt";

const SUBJECT = {
  firstName: "Ada",
  lastName: "Lovelace",
  occupation: "Technical founder",
  hobby: "chess",
};

describe("buildResearchPrompt — capabilities", () => {
  test("omits the capabilities block when no catalog is passed", () => {
    const prompt = buildResearchPrompt(SUBJECT);
    expect(prompt).not.toContain("Capabilities you can offer");
    expect(prompt).not.toContain('"plugins"');
  });

  test("injects passed capabilities and the plugins-list instruction", () => {
    const caps: AvailableCapability[] = [
      { name: "marketing-expert", description: "Full-stack marketing." },
      { name: "admin-copilot", description: "Proactive chief-of-staff." },
    ];
    const prompt = buildResearchPrompt(SUBJECT, caps);

    expect(prompt).toContain("Capabilities you can offer");
    expect(prompt).toContain("- marketing-expert — Full-stack marketing.");
    expect(prompt).toContain("- admin-copilot — Proactive chief-of-staff.");
    expect(prompt).toContain('"plugins"');
    // The canonical "exactly this shape" example must show plugins first, so a
    // model following the schema literally still emits the install list.
    expect(prompt.indexOf('"plugins"')).toBeLessThan(prompt.indexOf('"claims"'));
  });

  test("caps the injected list so a large catalog can't bloat the prompt", () => {
    const caps: AvailableCapability[] = Array.from({ length: 30 }, (_, i) => ({
      name: `plugin-${i}`,
      description: `Capability number ${i}.`,
    }));
    const prompt = buildResearchPrompt(SUBJECT, caps);

    const listed = caps.filter((c) => prompt.includes(`- ${c.name} —`)).length;
    expect(listed).toBe(12);
  });

  test("treats the submitted role as first-party context", () => {
    const prompt = buildResearchPrompt(SUBJECT);

    expect(prompt).toContain(
      "Treat the name, role, and hobby I provided above as first-party context from me.",
    );
    expect(prompt).toContain("not to override or correct it");
    expect(prompt).toContain("keep claims and suggestions aligned with my stated role");
  });
});

describe("buildResearchPrompt — suggestions toggle", () => {
  const caps: AvailableCapability[] = [
    { name: "marketing-expert", description: "Full-stack marketing." },
  ];

  test("includes suggestions by default (legacy flow unchanged)", () => {
    const prompt = buildResearchPrompt(SUBJECT, caps);

    expect(prompt).toContain('"suggestions"');
    expect(prompt).toContain('Rules for "suggestions":');
    expect(prompt).toContain("Generate EXACTLY 4 suggestions");
    // Claims + plugins still requested.
    expect(prompt).toContain('"claims"');
    expect(prompt).toContain('"plugins"');
  });

  test("omits all suggestion guidance when includeSuggestions is false", () => {
    const prompt = buildResearchPrompt(SUBJECT, caps, {
      includeSuggestions: false,
    });

    expect(prompt).not.toContain('"suggestions"');
    expect(prompt).not.toContain('Rules for "suggestions":');
    expect(prompt).not.toContain("Generate EXACTLY 4 suggestions");
    // The role-alignment line drops the "and suggestions" clause.
    expect(prompt).toContain("keep claims aligned with my stated role");
    expect(prompt).not.toContain("keep claims and suggestions aligned");
    // Plugins + claims are still requested, plugins still first in the shape.
    expect(prompt).toContain('"plugins"');
    expect(prompt).toContain('"claims"');
    expect(prompt.indexOf('"plugins"')).toBeLessThan(prompt.indexOf('"claims"'));
    // The closing fallback no longer references suggestions.
    expect(prompt).not.toContain("broadly useful suggestions");
  });
});
