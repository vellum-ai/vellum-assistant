import { describe, expect, test } from "bun:test";

import { advisorRequestText, buildAdvisorSystem } from "../consult-prompt.js";

describe("buildAdvisorSystem", () => {
  test("includes the senior-advisor framing", () => {
    const prompt = buildAdvisorSystem(null);
    expect(prompt).toContain("senior advisor");
  });

  test("embeds the parent prompt inside <agent_system_prompt> when provided", () => {
    const prompt = buildAdvisorSystem("You are a coding agent.");
    expect(prompt).toContain(
      "<agent_system_prompt>\nYou are a coding agent.\n</agent_system_prompt>",
    );
  });

  test("omits the <agent_system_prompt> block when no parent prompt is given", () => {
    const prompt = buildAdvisorSystem(null);
    expect(prompt).not.toContain("<agent_system_prompt>");
  });
});

describe("advisorRequestText", () => {
  test("is non-empty and asks for focused strategic guidance", () => {
    const text = advisorRequestText();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("focused strategic guidance");
  });

  test("imposes no length cap", () => {
    // The request must not constrain how much the advisor writes.
    expect(advisorRequestText()).not.toContain("words");
  });
});
