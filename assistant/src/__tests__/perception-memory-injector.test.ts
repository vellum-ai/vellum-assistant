/**
 * Tests for the `perception-memory-context` runtime injector.
 */

import { describe, expect, test } from "bun:test";

import { defaultInjectorsPlugin } from "../plugins/defaults/injectors.js";
import type { Injector, TurnContext } from "../plugins/types.js";

function findInjector(name: string): Injector {
  const injector = defaultInjectorsPlugin.injectors?.find(
    (candidate) => candidate.name === name,
  );
  if (!injector) {
    throw new Error(`injector '${name}' not registered`);
  }
  return injector;
}

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-test",
    conversationId: "conv-test",
    turnIndex: 0,
    trust: { sourceChannel: "vellum", trustClass: "guardian" },
    ...overrides,
  };
}

const injector = findInjector("perception-memory-context");

describe("perception-memory-context injector", () => {
  test("returns null when context is missing", async () => {
    const ctx = makeContext({ injectionInputs: {} });
    expect(await injector.produce(ctx)).toBeNull();
  });

  test("returns null in minimal mode", async () => {
    const ctx = makeContext({
      injectionInputs: {
        mode: "minimal",
        perceptionMemoryContext: "### Recent perceived episodes\n- test",
      },
    });
    expect(await injector.produce(ctx)).toBeNull();
  });

  test("wraps context with after-memory-prefix placement", async () => {
    const content = "### Recent perceived episodes\n- Edited runtime routes.";
    const ctx = makeContext({
      injectionInputs: { perceptionMemoryContext: content },
    });
    const block = await injector.produce(ctx);
    expect(block).not.toBeNull();
    expect(block!.id).toBe("perception-memory-context");
    expect(block!.placement).toBe("after-memory-prefix");
    expect(block!.text).toBe(
      `<perception_memory>\n${content}\n</perception_memory>`,
    );
  });
});
