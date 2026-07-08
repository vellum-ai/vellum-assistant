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

describe("buildResearchPrompt — calendarConnectedByFlow", () => {
  const caps: AvailableCapability[] = [
    { name: "marketing-expert", description: "Full-stack marketing." },
  ];

  test("is byte-for-byte unchanged when the flag is off or absent", () => {
    const absent = buildResearchPrompt(SUBJECT, caps);
    const explicitOff = buildResearchPrompt(SUBJECT, caps, {
      calendarConnectedByFlow: false,
    });

    expect(explicitOff).toBe(absent);
    // The legacy integration list (with Gmail/Calendar as connectable) stays.
    expect(absent).toContain(
      "an integration (GitHub, Gmail, Calendar, Slack, Linear) connected with a first action",
    );
    expect(absent).not.toContain("connected as part of this setup flow");
  });

  test("suppresses calendar-connect offers and assumes access when the flag is on", () => {
    const prompt = buildResearchPrompt(SUBJECT, caps, {
      calendarConnectedByFlow: true,
    });

    expect(prompt).toContain(
      "the user's Google Calendar is already connected",
    );
    expect(prompt).toContain('NEVER produce a "Connect your calendar"-style');
    // The user-voiced prompt must name Google Calendar so the downstream agent
    // doesn't ask which provider to use.
    expect(prompt).toContain("Prep my day each morning using my Google Calendar.");
    // Google/Gmail/Calendar drop out of the connectable-integration list.
    expect(prompt).toContain(
      "an integration you're NOT already connected to (GitHub, Slack, Linear)",
    );
    expect(prompt).not.toContain(
      "an integration (GitHub, Gmail, Calendar, Slack, Linear)",
    );
  });

  test("has no effect when suggestions are disabled", () => {
    const prompt = buildResearchPrompt(SUBJECT, caps, {
      includeSuggestions: false,
      calendarConnectedByFlow: true,
    });

    // Calendar guidance rides inside the suggestion rules, which are omitted.
    expect(prompt).not.toContain("connected as part of this setup flow");
    expect(prompt).not.toContain('Rules for "suggestions":');
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
