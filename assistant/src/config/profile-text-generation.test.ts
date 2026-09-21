import { afterAll, describe, expect, mock, test } from "bun:test";

// No shipped catalog model opts out of text generation today (decision
// models live in the classification catalog), so stub the capability lookup
// to exercise the guard against a non-text model.
const NON_TEXT = { provider: "acme-judge", model: "verdict-1" };

const actualCatalog = await import("../providers/model-catalog.js");
mock.module("../providers/model-catalog.js", () => ({
  ...actualCatalog,
  catalogModelSupportsText: (provider?: string, model?: string) =>
    !(provider === NON_TEXT.provider && model === NON_TEXT.model),
}));

const { nonTextConversationProfileMessage, profileSupportsTextGeneration } =
  await import("./profile-text-generation.js");

afterAll(() => {
  mock.restore();
});

describe("profileSupportsTextGeneration", () => {
  test("false for a structured-decision catalog model", () => {
    expect(profileSupportsTextGeneration(NON_TEXT, {})).toBe(false);
  });

  test("true for a chat model and for unlisted custom ids", () => {
    expect(
      profileSupportsTextGeneration(
        { provider: "anthropic", model: "claude-opus-4-8" },
        {},
      ),
    ).toBe(true);
    expect(
      profileSupportsTextGeneration(
        { provider: "openai-compatible", model: "local-mixtral" },
        {},
      ),
    ).toBe(true);
  });

  test("a mix is false when any arm is non-text", () => {
    expect(
      profileSupportsTextGeneration(
        { mix: [{ profile: "judge" }, { profile: "balanced" }] },
        {
          judge: NON_TEXT,
          balanced: { provider: "anthropic", model: "claude-opus-4-8" },
        },
      ),
    ).toBe(false);
  });

  test("names the profile in the conversation-model error", () => {
    expect(nonTextConversationProfileMessage("judge")).toContain("judge");
    expect(nonTextConversationProfileMessage("judge")).toContain(
      "structured answers rather than chat text",
    );
  });
});
