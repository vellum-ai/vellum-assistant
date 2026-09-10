/**
 * Covers the ACP config leaf that carries model selection, the per-agent
 * `model`. It is optional with no `.default()`, so an absent value must stay
 * absent after parsing: the bundled profile supplies the model a session
 * starts on, and a key materialized as `undefined` would shadow it.
 */

import { describe, expect, test } from "bun:test";

import { AcpAgentConfigSchema, AcpConfigSchema } from "./acp-schema.js";

describe("AcpConfigSchema", () => {
  test("populates defaults for an empty config", () => {
    expect(AcpConfigSchema.parse({})).toEqual({
      maxConcurrentSessions: 4,
      agents: {},
    });
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

  test("leaves model unset when omitted, so a bundled profile's shows through", () => {
    const parsed = AcpAgentConfigSchema.parse({ command: "claude-agent-acp" });

    expect(parsed.model).toBeUndefined();
    expect("model" in parsed).toBe(false);
  });

  test("rejects a non-string model", () => {
    expect(
      AcpAgentConfigSchema.safeParse({ command: "claude-agent-acp", model: 3 })
        .success,
    ).toBe(false);
  });
});
