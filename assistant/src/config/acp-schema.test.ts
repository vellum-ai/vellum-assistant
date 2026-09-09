/**
 * Covers the ACP config leaves that carry model selection: `acp.defaultModel`
 * and the per-agent `model` override. Both are optional with no `.default()`,
 * so an absent value must stay absent after parsing rather than becoming a
 * value the daemon would then apply to a session.
 */

import { describe, expect, test } from "bun:test";

import { AcpAgentConfigSchema, AcpConfigSchema } from "./acp-schema.js";

describe("AcpConfigSchema", () => {
  test("populates defaults and leaves defaultModel unset for an empty config", () => {
    const parsed = AcpConfigSchema.parse({});

    expect(parsed).toEqual({ maxConcurrentSessions: 4, agents: {} });
    expect(parsed.defaultModel).toBeUndefined();
    expect("defaultModel" in parsed).toBe(false);
  });

  test("round-trips a defaultModel alias", () => {
    expect(AcpConfigSchema.parse({ defaultModel: "opus" }).defaultModel).toBe(
      "opus",
    );
  });

  test("rejects a non-string defaultModel", () => {
    expect(AcpConfigSchema.safeParse({ defaultModel: 3 }).success).toBe(false);
  });
});

describe("AcpAgentConfigSchema", () => {
  test("round-trips a per-agent model override", () => {
    expect(
      AcpAgentConfigSchema.parse({
        command: "claude-agent-acp",
        model: "opus",
      }),
    ).toEqual({ command: "claude-agent-acp", args: [], model: "opus" });
  });

  test("leaves model unset when omitted", () => {
    const parsed = AcpAgentConfigSchema.parse({ command: "claude-agent-acp" });

    expect(parsed.model).toBeUndefined();
    expect("model" in parsed).toBe(false);
  });
});
