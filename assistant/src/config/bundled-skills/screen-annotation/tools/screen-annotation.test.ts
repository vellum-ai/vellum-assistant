import { describe, expect, test } from "bun:test";

import type { ToolContext } from "../../../../tools/types.js";
import { run as clearMarks } from "./screen-clear-marks.js";
import { run as pointAt } from "./screen-point-at.js";

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
});
