import { describe, expect, test } from "bun:test";

import { explicitTools } from "../tool-manifest.js";
import type { ToolContext } from "../types.js";
import { computerUsePointAtTool } from "./point-at.js";

const MARKS = { marks: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }] };

describe("computer_use_point_at", () => {
  /**
   * The prefix is what routes this to the desktop client:
   * `surfaceProxyResolver` sends every `computer_use_*` tool through the host
   * CU proxy. Renaming it away from that prefix would leave the tool
   * resolving nowhere.
   */
  test("is named so the proxy resolver routes it to the client", () => {
    expect(computerUsePointAtTool.name.startsWith("computer_use_")).toBe(true);
  });

  /**
   * A core tool rather than one of the computer-use skill's. Pointing at the
   * screen is how the assistant answers a question in a call, so it cannot
   * sit behind a skill load.
   */
  test("is registered as a core tool", () => {
    expect(explicitTools).toContain(computerUsePointAtTool);
  });

  test("forwards the marks to the connected client", async () => {
    const calls: { toolName: string; input: Record<string, unknown> }[] = [];
    const context = {
      proxyToolResolver: async (
        toolName: string,
        input: Record<string, unknown>,
      ) => {
        calls.push({ toolName, input });
        return {
          content: "Drew 1 mark on the shared surface.",
          isError: false,
        };
      },
    } as unknown as ToolContext;

    const result = await computerUsePointAtTool.execute(MARKS, context);

    expect(calls).toEqual([
      { toolName: "computer_use_point_at", input: MARKS },
    ]);
    expect(result.isError).toBe(false);
  });

  /** No desktop client is a normal failure, not a throw. */
  test("fails with a message when no client is connected", async () => {
    const result = await computerUsePointAtTool.execute(
      MARKS,
      {} as unknown as ToolContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("connected desktop client");
  });
});
