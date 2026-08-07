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
  hobbies: ["chess"],
};

describe("buildResearchPrompt — hobbies rendering", () => {
  test("joins multiple hobbies into the stated-details sentence", () => {
    const prompt = buildResearchPrompt({
      ...SUBJECT,
      hobbies: ["chess", "gardening"],
    });
    expect(prompt).toContain("My hobby is chess, gardening.");
  });

  test("omits the hobby sentence when no hobbies were picked", () => {
    expect(buildResearchPrompt({ ...SUBJECT, hobbies: [] })).not.toContain(
      "My hobby is",
    );
    expect(
      buildResearchPrompt({ ...SUBJECT, hobbies: undefined }),
    ).not.toContain("My hobby is");
  });

  test("drops blank chips rather than rendering empty list items", () => {
    const prompt = buildResearchPrompt({
      ...SUBJECT,
      hobbies: ["chess", "   ", ""],
    });
    expect(prompt).toContain("My hobby is chess.");
  });
});

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
    expect(prompt.indexOf('"plugins"')).toBeLessThan(
      prompt.indexOf('"claims"'),
    );
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
    expect(prompt).toContain(
      "keep claims and suggestions aligned with my stated role",
    );
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
    expect(prompt.indexOf('"plugins"')).toBeLessThan(
      prompt.indexOf('"claims"'),
    );
    // The closing fallback no longer references suggestions.
    expect(prompt).not.toContain("broadly useful suggestions");
  });
});

describe("buildResearchPrompt — parallel search batching", () => {
  test("asks for parallel tool calls in two batches", () => {
    const prompt = buildResearchPrompt(SUBJECT);

    expect(prompt).toContain("SEARCH IN PARALLEL");
    expect(prompt).toContain("AS PARALLEL TOOL CALLS IN ONE STEP");
    expect(prompt).toContain("Batch 1 — discovery.");
    expect(prompt).toContain("Batch 2 — corroboration.");
    // A cap keeps the discovery fan-out from turning into a search storm.
    expect(prompt).toContain("at most 5 total");
  });

  test("bans subagent delegation", () => {
    // Not a style preference: a subagent result is injected into the parent as
    // a user message that starts a new turn, and a partial-but-complete payload
    // from one of those turns settles the runner's poll on a half-researched
    // card. See the module docstring.
    const prompt = buildResearchPrompt(SUBJECT);

    expect(prompt).toContain("Do NOT delegate this to subagents");
  });

  test("gates the discovery batch on the placeholder rule", () => {
    // The placeholder escape hatch lives in the identity gate, which is stated
    // AFTER the batches — without this forward reference a model reading in
    // order fires five searches for junk input before reaching it.
    const prompt = buildResearchPrompt(SUBJECT);

    expect(prompt).toContain("First check the placeholder rule");
    expect(prompt.indexOf("First check the placeholder rule")).toBeLessThan(
      prompt.indexOf("placeholder or joke input"),
    );
  });

  test("batching does not displace the identity gate or the JSON contract", () => {
    const prompt = buildResearchPrompt(SUBJECT, [
      { name: "marketing-expert", description: "Full-stack marketing." },
    ]);

    // Ordering is load-bearing: batches are described before the gate that
    // judges their output, which is before the shape the gate feeds.
    expect(prompt.indexOf("SEARCH IN PARALLEL")).toBeLessThan(
      prompt.indexOf("IDENTITY GATE"),
    );
    expect(prompt.indexOf("IDENTITY GATE")).toBeLessThan(
      prompt.indexOf('"plugins"'),
    );
    expect(prompt).toContain("run the identity gate below");
  });
});

describe("buildResearchPrompt — identity gate & confidence calibration", () => {
  test("states the identity gate and the honest no-match fallback", () => {
    const prompt = buildResearchPrompt(SUBJECT);

    expect(prompt).toContain("IDENTITY GATE");
    expect(prompt).toContain(
      "a name match alone is NEVER enough to attribute a page to me",
    );
    expect(prompt).toContain('each labeled "guessing" with "sources": []');
  });

  test("skips research entirely on placeholder or joke input", () => {
    const prompt = buildResearchPrompt(SUBJECT);

    expect(prompt).toContain("placeholder or joke input");
    expect(prompt).toContain(
      "skip the web search and return an empty claims array",
    );
  });

  test("ties confidence tiers to evidence instead of demanding a spread", () => {
    const prompt = buildResearchPrompt(SUBJECT);

    // The old instruction manufactured false confidence for people with no
    // public footprint — it must not come back.
    expect(prompt).not.toContain("Aim for at least one");
    expect(prompt).toContain(
      '"confident" needs 2+ independent gate-passing sources',
    );
    expect(prompt).toContain('must be "guessing"');
  });

  test("bans aggregator sources and synthesized specifics", () => {
    const prompt = buildResearchPrompt(SUBJECT);

    expect(prompt).toContain(
      "Never fetch or cite people-search or background-check aggregators",
    );
    expect(prompt).toContain("never synthesize or embellish specifics");
  });

  test("renders the timezone line only when a timezone is given", () => {
    const withTz = buildResearchPrompt({
      ...SUBJECT,
      timezone: "America/Denver",
    });

    expect(withTz).toContain("My timezone is America/Denver.");
    expect(buildResearchPrompt(SUBJECT)).not.toContain("My timezone is");
  });

  test("an empty form still yields the get-to-know-me fallback, not a bare timezone", () => {
    const prompt = buildResearchPrompt({
      firstName: "",
      lastName: "",
      occupation: "",
      timezone: "America/Denver",
    });

    expect(prompt).toContain(
      "I'd like you to get to know me before we start working together.",
    );
    expect(prompt).not.toContain("My timezone is");
  });
});
