import { describe, expect, test } from "bun:test";

import { forwardComputerUseProxyTool } from "../tools/computer-use/skill-proxy-bridge.js";
import type { ToolContext } from "../tools/types.js";

const ctx: ToolContext = {
  workingDir: "/tmp",
  conversationId: "conv-123",
  trustClass: "guardian",
};

describe("forwardComputerUseProxyTool", () => {
  test("returns error when no proxy resolver available", async () => {
    const result = await forwardComputerUseProxyTool(
      "computer_use_click",
      {},
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "The Vellum desktop app is needed to view or control your screen",
    );
    expect(result.content).toContain("https://www.vellum.ai/downloads");
    expect(result.content).not.toContain("computer_use_click");
  });

  test("delegates to proxy resolver when available", async () => {
    const ctxWithProxy: ToolContext = {
      ...ctx,
      proxyToolResolver: async (
        name: string,
        input: Record<string, unknown>,
      ) => ({
        content: `Forwarded ${name} with ${JSON.stringify(input)}`,
        isError: false,
      }),
    };

    const result = await forwardComputerUseProxyTool(
      "computer_use_screenshot",
      { reasoning: "test" },
      ctxWithProxy,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Forwarded computer_use_screenshot");
    expect(result.content).toContain("test");
  });
});
