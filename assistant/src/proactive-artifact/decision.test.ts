import { describe, expect, test } from "bun:test";

import {
  type DecisionOutput,
  formatTranscript,
  parseDecisionOutput,
} from "./decision.js";

describe("parseDecisionOutput", () => {
  test("parses SHOULD_BUILD: yes with all fields correctly", () => {
    const text = `SHOULD_BUILD: yes
ARTIFACT_TYPE: app
ARTIFACT_TITLE: Sarah's Marathon Training Pace Calculator
ARTIFACT_DESCRIPTION: An interactive pace calculator that accounts for Sarah's goal of a sub-4-hour marathon, her current 9:30/mile easy pace, and the hilly terrain of the Boston course.`;

    const result = parseDecisionOutput(text);
    expect(result).toEqual({
      shouldBuild: true,
      artifactType: "app",
      artifactTitle: "Sarah's Marathon Training Pace Calculator",
      artifactDescription:
        "An interactive pace calculator that accounts for Sarah's goal of a sub-4-hour marathon, her current 9:30/mile easy pace, and the hilly terrain of the Boston course.",
    });
  });

  test("parses SHOULD_BUILD: no with skip reason", () => {
    const text = `SHOULD_BUILD: no
SKIP_REASON: The conversation is too early and generic — the user has only asked a factual question with no personal context.`;

    const result = parseDecisionOutput(text);
    expect(result).toEqual({
      shouldBuild: false,
      skipReason:
        "The conversation is too early and generic — the user has only asked a factual question with no personal context.",
    });
  });

  test("parses SHOULD_BUILD: no without skip reason defaults to 'no reason given'", () => {
    const text = `SHOULD_BUILD: no`;

    const result = parseDecisionOutput(text);
    expect(result).toEqual({
      shouldBuild: false,
      skipReason: "no reason given",
    });
  });

  test("returns null for missing SHOULD_BUILD line", () => {
    const text = `ARTIFACT_TYPE: app
ARTIFACT_TITLE: Some Title
ARTIFACT_DESCRIPTION: Some description.`;

    const result = parseDecisionOutput(text);
    expect(result).toBeNull();
  });

  test("returns null when yes but ARTIFACT_TYPE is missing", () => {
    const text = `SHOULD_BUILD: yes
ARTIFACT_TITLE: Some Title
ARTIFACT_DESCRIPTION: Some description.`;

    const result = parseDecisionOutput(text);
    expect(result).toBeNull();
  });

  test("returns null when yes but ARTIFACT_TYPE is invalid", () => {
    const text = `SHOULD_BUILD: yes
ARTIFACT_TYPE: widget
ARTIFACT_TITLE: Some Title
ARTIFACT_DESCRIPTION: Some description.`;

    const result = parseDecisionOutput(text);
    expect(result).toBeNull();
  });

  test("returns null when yes but ARTIFACT_TITLE is missing", () => {
    const text = `SHOULD_BUILD: yes
ARTIFACT_TYPE: document
ARTIFACT_DESCRIPTION: Some description.`;

    const result = parseDecisionOutput(text);
    expect(result).toBeNull();
  });

  test("returns null when yes but ARTIFACT_DESCRIPTION is missing", () => {
    const text = `SHOULD_BUILD: yes
ARTIFACT_TYPE: document
ARTIFACT_TITLE: Some Title`;

    const result = parseDecisionOutput(text);
    expect(result).toBeNull();
  });

  test("returns null when yes but ARTIFACT_TITLE is empty", () => {
    const text = `SHOULD_BUILD: yes
ARTIFACT_TYPE: app
ARTIFACT_TITLE:
ARTIFACT_DESCRIPTION: Some description.`;

    const result = parseDecisionOutput(text);
    expect(result).toBeNull();
  });

  test("handles multi-line ARTIFACT_DESCRIPTION", () => {
    const text = `SHOULD_BUILD: yes
ARTIFACT_TYPE: document
ARTIFACT_TITLE: Jake's Q3 OKR Tracker
ARTIFACT_DESCRIPTION: A structured comparison table for Jake's three competing priorities:
scaling the data pipeline from 10M to 50M events/day,
hiring two senior engineers by September,
and reducing p99 latency below 200ms.`;

    const result = parseDecisionOutput(text) as DecisionOutput & {
      shouldBuild: true;
    };
    expect(result).not.toBeNull();
    expect(result.shouldBuild).toBe(true);
    expect(result.artifactType).toBe("document");
    expect(result.artifactTitle).toBe("Jake's Q3 OKR Tracker");
    expect(result.artifactDescription).toContain(
      "A structured comparison table",
    );
    expect(result.artifactDescription).toContain(
      "reducing p99 latency below 200ms",
    );
  });

  test("handles case-insensitive SHOULD_BUILD value", () => {
    const text = `SHOULD_BUILD: Yes
ARTIFACT_TYPE: app
ARTIFACT_TITLE: Test Title
ARTIFACT_DESCRIPTION: Test description.`;

    const result = parseDecisionOutput(text);
    expect(result).not.toBeNull();
    expect(result!.shouldBuild).toBe(true);
  });

  test("handles case-insensitive ARTIFACT_TYPE value", () => {
    const text = `SHOULD_BUILD: yes
ARTIFACT_TYPE: Document
ARTIFACT_TITLE: Test Title
ARTIFACT_DESCRIPTION: Test description.`;

    const result = parseDecisionOutput(text);
    expect(result).not.toBeNull();
    expect((result as { artifactType: string }).artifactType).toBe("document");
  });
});

describe("formatTranscript", () => {
  test("formats plain text messages correctly", () => {
    const messages = [
      { role: "user", content: "Hello, I need help with my project" },
      {
        role: "assistant",
        content: "I'd be happy to help! What kind of project?",
      },
      {
        role: "user",
        content: "I'm building a fitness tracker for marathon training",
      },
    ];

    const result = formatTranscript(messages);
    expect(result).toBe(
      `[User]: Hello, I need help with my project

[Assistant]: I'd be happy to help! What kind of project?

[User]: I'm building a fitness tracker for marathon training`,
    );
  });

  test("handles JSON content blocks", () => {
    const messages = [
      {
        role: "user",
        content: JSON.stringify([{ type: "text", text: "What is 2+2?" }]),
      },
      {
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "The answer is 4." },
          { type: "text", text: "Would you like to know more?" },
        ]),
      },
    ];

    const result = formatTranscript(messages);
    expect(result).toBe(
      `[User]: What is 2+2?

[Assistant]: The answer is 4.
Would you like to know more?`,
    );
  });

  test("handles mixed JSON and plain text messages", () => {
    const messages = [
      {
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Help me plan my week" },
        ]),
      },
      { role: "assistant", content: "Sure, what do you have coming up?" },
    ];

    const result = formatTranscript(messages);
    expect(result).toBe(
      `[User]: Help me plan my week

[Assistant]: Sure, what do you have coming up?`,
    );
  });

  test("handles unknown roles", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant" },
    ];

    const result = formatTranscript(messages);
    expect(result).toBe("[system]: You are a helpful assistant");
  });
});
