import { describe, expect, test } from "bun:test";

import { AcpSessionUsageEventSchema } from "./acp-session-usage.js";

describe("AcpSessionUsageEventSchema", () => {
  test("parses an event carrying cumulative input/output tokens", () => {
    const event = {
      type: "acp_session_usage" as const,
      acpSessionId: "acp-session-abc",
      usedTokens: 1200,
      contextSize: 200000,
      inputTokens: 950,
      outputTokens: 250,
      costAmount: 0.42,
      costCurrency: "USD",
    };

    const result = AcpSessionUsageEventSchema.safeParse(event);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(event);
  });

  test("parses a usage event without the token fields", () => {
    const event = {
      type: "acp_session_usage" as const,
      acpSessionId: "acp-session-abc",
      usedTokens: 1200,
      contextSize: 200000,
    };

    const result = AcpSessionUsageEventSchema.safeParse(event);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(event);
  });

  test("rejects an unrecognized field under .strict()", () => {
    const result = AcpSessionUsageEventSchema.safeParse({
      type: "acp_session_usage",
      acpSessionId: "acp-session-abc",
      usedTokens: 1200,
      contextSize: 200000,
      unexpected: true,
    });

    expect(result.success).toBe(false);
  });
});
