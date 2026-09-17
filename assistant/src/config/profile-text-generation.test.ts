import { describe, expect, test } from "bun:test";

import {
  nonTextConversationProfileMessage,
  profileSupportsTextGeneration,
} from "./profile-text-generation.js";

describe("profileSupportsTextGeneration", () => {
  test("false for a structured-decision catalog model", () => {
    expect(
      profileSupportsTextGeneration(
        { provider: "jev", model: "jev-latest" },
        {},
      ),
    ).toBe(false);
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
        { mix: [{ profile: "jev" }, { profile: "balanced" }] },
        {
          jev: { provider: "jev", model: "jev-latest" },
          balanced: { provider: "anthropic", model: "claude-opus-4-8" },
        },
      ),
    ).toBe(false);
  });

  test("names the profile in the conversation-model error", () => {
    expect(nonTextConversationProfileMessage("jev")).toContain("jev");
    expect(nonTextConversationProfileMessage("jev")).toContain(
      "structured answers rather than chat text",
    );
  });
});
