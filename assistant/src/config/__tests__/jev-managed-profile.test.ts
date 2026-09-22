import { describe, expect, test } from "bun:test";

import { LLMSchema } from "../schemas/llm.js";

const PIN = { callSites: { voiceEscalationJudge: { profile: "jev-managed" } } };

describe("jev-managed as a call-site pin target", () => {
  test("resolves under the managed default provider", () => {
    expect(LLMSchema.safeParse(PIN).success).toBe(true);
    expect(
      LLMSchema.safeParse({
        ...PIN,
        defaultProvider: { provider: "vellum" },
      }).success,
    ).toBe(true);
  });

  test("is rejected under a BYOK default provider, where it has no body", () => {
    const result = LLMSchema.safeParse({
      ...PIN,
      defaultProvider: {
        provider: "anthropic",
        connectionName: "anthropic-personal",
      },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "managed Jev profile",
    );
  });
});
