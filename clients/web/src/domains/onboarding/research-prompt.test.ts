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
});
