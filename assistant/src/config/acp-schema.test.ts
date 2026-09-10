/**
 * Covers the ACP config leaf that carries model selection, the per-agent
 * `model`. It is optional with no `.default()`, so an absent value must stay
 * absent after parsing: the bundled profile supplies the model a session
 * starts on, and a key materialized as `undefined` would shadow it.
 *
 * `command` is optional in the same shape, so an entry for a bundled id can
 * carry a model and nothing else; the record's own check keeps a command
 * required for every id that has no bundled profile to inherit one from.
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

describe("AcpConfigSchema agents", () => {
  test("a bundled id's entry may omit command and name only a model", () => {
    const parsed = AcpConfigSchema.parse({
      agents: { claude: { model: "sonnet" } },
    });

    expect(parsed.agents).toEqual({ claude: { args: [], model: "sonnet" } });
    expect("command" in parsed.agents.claude!).toBe(false);
  });

  test("an id with no bundled profile needs a command", () => {
    const result = AcpConfigSchema.safeParse({
      agents: { mine: { model: "sonnet" } },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.issues.map((issue) => issue.path)).toEqual([
      ["agents", "mine", "command"],
    ]);
    expect(result.error.issues[0]?.message).toContain("acp.agents.mine");
  });

  test("an id naming an Object.prototype member inherits no command", () => {
    expect(
      AcpConfigSchema.safeParse({ agents: { constructor: { model: "x" } } })
        .success,
    ).toBe(false);
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
