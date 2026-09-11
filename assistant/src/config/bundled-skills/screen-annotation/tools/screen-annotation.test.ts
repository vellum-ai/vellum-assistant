import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { ToolContext } from "../../../../tools/types.js";
import { createAbortReason } from "../../../../util/abort-reasons.js";
import { run as clearMarks } from "./screen-clear-marks.js";
import { run as pointAt } from "./screen-point-at.js";

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort(createAbortReason("user_cancel", "screen-annotation.test"));
  return controller.signal;
}

function recorder() {
  const calls: { toolName: string; input: Record<string, unknown> }[] = [];
  const context = {
    proxyToolResolver: async (
      toolName: string,
      input: Record<string, unknown>,
    ) => {
      calls.push({ toolName, input });
      return { content: "ok", isError: false };
    },
  } as unknown as ToolContext;
  return { calls, context };
}

const MARK = { x: 0.1, y: 0.2, width: 0.3, height: 0.1, caption: "Press" };

describe("screen_point_at", () => {
  /**
   * The wire name is the route: `surfaceProxyResolver` forwards tools by the
   * `computer_use_` prefix to the connected desktop client, which answers this
   * one in its own main process. The name the model reads belongs to the
   * skill; renaming the wire name would leave the tool resolving nowhere.
   */
  test("forwards under the name the proxy resolver routes on", async () => {
    const { calls, context } = recorder();

    await pointAt({ marks: [MARK] }, context);

    expect(calls).toEqual([
      { toolName: "computer_use_point_at", input: { marks: [MARK] } },
    ]);
  });

  test("fails with a message when no client is connected", async () => {
    const result = await pointAt(
      { marks: [MARK] },
      {} as unknown as ToolContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("connected desktop client");
  });

  /** Drawing on the user's screen is a side effect a stopped turn must not have. */
  test("a cancelled turn draws nothing", async () => {
    const { calls, context } = recorder();

    await expect(
      pointAt({ marks: [MARK] }, { ...context, signal: abortedSignal() }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("screen_clear_marks", () => {
  /** Nothing pointed at is the same request carrying nothing. */
  test("clears by sending no marks", async () => {
    const { calls, context } = recorder();

    await clearMarks({}, context);

    expect(calls).toEqual([
      { toolName: "computer_use_point_at", input: { marks: [] } },
    ]);
  });

  /** The pick has to survive, or a clear lands on a different machine. */
  test("keeps the client it was aimed at", async () => {
    const { calls, context } = recorder();

    await clearMarks({ target_client_id: "client-9" }, context);

    expect(calls[0]?.input).toEqual({
      target_client_id: "client-9",
      marks: [],
    });
  });

  /**
   * Teardown, so it runs on a cancelled turn. It shares a wire name with
   * pointing, which the guard does stop, so the exemption is stated by the
   * caller rather than read off the name.
   */
  test("a cancelled turn still takes the marks down", async () => {
    const { calls, context } = recorder();

    const result = await clearMarks({}, {
      ...context,
      signal: abortedSignal(),
    } as ToolContext);

    expect(result.isError).toBe(false);
    expect(calls).toEqual([
      { toolName: "computer_use_point_at", input: { marks: [] } },
    ]);
  });
});

/**
 * The shape of a mark, as the model is told it.
 *
 * The published schema is the only account of the contract the model ever
 * sees: a mark it composes from that schema and sends is rejected on the host
 * by a union that admits exactly two shapes, and the model has no way to
 * learn why. So the schema carries the same two shapes.
 */
describe("the published mark schema", () => {
  interface OneOfBranch {
    required?: string[];
  }
  interface ItemSchema {
    oneOf?: OneOfBranch[];
    properties?: Record<string, unknown>;
  }
  const toolsJson = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "TOOLS.json"), "utf-8"),
  ) as {
    tools: {
      name: string;
      input_schema: { properties: { marks: { items: ItemSchema } } };
    }[];
  };
  const item = toolsJson.tools.find((tool) => tool.name === "screen_point_at")!
    .input_schema.properties.marks.items;

  /** `oneOf` as JSON Schema reads it: satisfied by exactly one branch. */
  const accepts = (mark: Record<string, unknown>): boolean => {
    const fits = (item.oneOf ?? []).filter((branch) =>
      (branch.required ?? []).every((key) => key in mark),
    );
    return fits.length === 1;
  };

  test("a named target is a mark", () => {
    expect(accepts({ target: "Send" })).toBe(true);
    expect(accepts({ target: "Send", caption: "Click this" })).toBe(true);
  });

  test("all four bounds are a mark", () => {
    expect(accepts({ x: 0.1, y: 0.2, width: 0.3, height: 0.1 })).toBe(true);
  });

  test("neither shape, or half of one, is not a mark", () => {
    expect(accepts({})).toBe(false);
    expect(accepts({ caption: "Click this" })).toBe(false);
    expect(accepts({ x: 0.2 })).toBe(false);
    expect(accepts({ x: 0.1, y: 0.2, width: 0.3 })).toBe(false);
  });

  /** An empty name is a name of nothing, and the host rejects it as one. */
  test("a target has to say something", () => {
    const target = item.properties?.target as { minLength?: number };
    expect(target.minLength).toBe(1);
  });

  /** Both shapes at once names a target and estimates it in the same breath. */
  test("a name and bounds together is not a mark", () => {
    expect(
      accepts({ target: "Send", x: 0.1, y: 0.2, width: 0.3, height: 0.1 }),
    ).toBe(false);
  });
});
