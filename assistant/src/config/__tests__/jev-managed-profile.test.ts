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

  test("can be pinned only to the verdict-consuming call sites", () => {
    for (const site of [
      "voiceEscalationJudge",
      "voiceContinuationJudge",
      "memoryV3SelectL2",
    ]) {
      expect(
        LLMSchema.safeParse({
          callSites: { [site]: { profile: "jev-managed" } },
        }).success,
      ).toBe(true);
    }
    const result = LLMSchema.safeParse({
      callSites: { conversationTitle: { profile: "jev-managed" } },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "can only be pinned to",
    );
  });

  test("cannot be a mix constituent", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        blend: {
          mix: [
            { profile: "jev-managed", weight: 1 },
            { profile: "balanced", weight: 1 },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "cannot be a mix constituent",
    );
  });

  test("is rejected as the active or advisor profile even on the managed column", () => {
    for (const field of ["activeProfile", "advisorProfile"] as const) {
      const result = LLMSchema.safeParse({ [field]: "jev-managed" });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(
        "structured answers rather than chat text",
      );
    }
    expect(LLMSchema.safeParse({ activeProfile: "balanced" }).success).toBe(
      true,
    );
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
