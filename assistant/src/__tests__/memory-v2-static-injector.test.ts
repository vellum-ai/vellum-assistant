/**
 * Tests for the `memory-v2-static` runtime injector.
 *
 * Covers:
 *   - Returns null when `memoryV2Static` is missing/empty.
 *   - Returns null when `mode === "minimal"`.
 *   - Wraps content in `<memory>...</memory>` and uses
 *     `after-memory-prefix` placement.
 *   - Escapes any `</memory>` substring inside the authored content so the
 *     wrapper cannot be broken out of.
 *
 * Hermetic: drives the injector's `produce()` directly with a synthesized
 * `TurnContext` — no daemon, no filesystem.
 */

import { describe, expect, test } from "bun:test";

import { defaultInjectorsPlugin } from "../plugins/defaults/injectors.js";
import type { Injector, TurnContext } from "../plugins/types.js";

function findInjector(name: string): Injector {
  const injector = defaultInjectorsPlugin.injectors?.find(
    (i) => i.name === name,
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

const memoryV2StaticInjector = findInjector("memory-v2-static");

describe("memory-v2-static injector", () => {
  test("returns null when memoryV2Static is undefined", async () => {
    const ctx = makeContext({ injectionInputs: {} });
    expect(await memoryV2StaticInjector.produce(ctx)).toBeNull();
  });

  test("returns null when memoryV2Static is null", async () => {
    const ctx = makeContext({ injectionInputs: { memoryV2Static: null } });
    expect(await memoryV2StaticInjector.produce(ctx)).toBeNull();
  });

  test("returns null when memoryV2Static is an empty string", async () => {
    const ctx = makeContext({ injectionInputs: { memoryV2Static: "" } });
    expect(await memoryV2StaticInjector.produce(ctx)).toBeNull();
  });

  test("returns null in minimal mode even with content", async () => {
    const ctx = makeContext({
      injectionInputs: {
        mode: "minimal",
        memoryV2Static: "## Essentials\n\nAlice prefers VS Code.",
      },
    });
    expect(await memoryV2StaticInjector.produce(ctx)).toBeNull();
  });

  test("wraps content in <memory>...</memory> with after-memory-prefix placement", async () => {
    const content =
      "## Essentials\n\nAlice prefers VS Code.\n\n## Threads\n\nOpen: ship PR.";
    const ctx = makeContext({
      injectionInputs: { memoryV2Static: content },
    });

    const block = await memoryV2StaticInjector.produce(ctx);
    expect(block).not.toBeNull();
    expect(block!.id).toBe("memory-v2-static");
    expect(block!.placement).toBe("after-memory-prefix");
    expect(block!.text).toBe(`<memory>\n${content}\n</memory>`);
  });

  test("escapes inner </memory> closing tags so the wrapper cannot be broken out of", async () => {
    const content = "## Essentials\n\nText with </memory> embedded.";
    const ctx = makeContext({
      injectionInputs: { memoryV2Static: content },
    });

    const block = await memoryV2StaticInjector.produce(ctx);
    expect(block).not.toBeNull();
    expect(block!.text).toBe(
      "<memory>\n## Essentials\n\nText with &lt;/memory&gt; embedded.\n</memory>",
    );
  });
});
