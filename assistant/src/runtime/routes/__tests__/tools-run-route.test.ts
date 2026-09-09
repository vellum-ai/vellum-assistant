/**
 * Tests for the `tools_run_post` route, the transport behind
 * `assistant tools run`.
 *
 * The tool registry is per-process. Skill, plugin, and MCP tools are
 * registered in the daemon over its lifetime and exist nowhere else, so a CLI
 * process resolving a tool name itself reaches only core built-ins and
 * workspace tools. That is why `assistant tools list`, which already reads this
 * registry over IPC, could report an `mcp__*` tool that `tools run` then
 * rejected as unknown. This route is what closes the gap.
 *
 * What matters here beyond the happy path: an unknown name is a 404 rather than
 * a 500, and the route stays local-principal + `settings.write`. Reaching a
 * larger registry must not become a way for a remote caller to drive tool
 * execution outside a conversation.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

/** Mirrors the real class so the handler's `instanceof` check resolves. */
class UnknownToolError extends Error {
  constructor(toolName: string) {
    super(
      `Unknown tool "${toolName}". Run 'assistant tools list' to see registered tools.`,
    );
    this.name = "UnknownToolError";
  }
}

const runToolStandalone = mock(
  async (toolName: string, _input: Record<string, unknown>) => ({
    toolName,
    content: "ok",
    isError: false,
    riskLevel: "low",
  }),
);

mock.module("../../../tools/run-standalone.js", () => ({
  runToolStandalone,
  UnknownToolError,
}));

const { ROUTES } = await import("../settings-routes.js");
const { RouteError } = await import("../errors.js");
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

const route: RouteDefinition = (() => {
  const found = ROUTES.find((r) => r.operationId === "tools_run_post");
  if (!found) {
    throw new Error("tools_run_post route not registered");
  }
  return found;
})();

/** Call the handler with a body, as the IPC and HTTP adapters both do. */
function callRoute(body: unknown) {
  return route.handler({ body } as RouteHandlerArgs);
}

/** The status code a thrown RouteError carries, or null for anything else. */
async function statusOf(body: unknown): Promise<number | null> {
  try {
    await callRoute(body);
    return null;
  } catch (err) {
    return err instanceof RouteError ? err.statusCode : null;
  }
}

beforeEach(() => {
  runToolStandalone.mockClear();
});

describe("tools_run_post", () => {
  test("runs the named tool and returns its result", async () => {
    const result = await callRoute({
      toolName: "mcp__fastmail__search_email",
      input: { query: "in:inbox" },
    });

    expect(runToolStandalone).toHaveBeenCalledWith(
      "mcp__fastmail__search_email",
      { query: "in:inbox" },
    );
    expect(result).toMatchObject({
      toolName: "mcp__fastmail__search_email",
      content: "ok",
      isError: false,
    });
  });

  test("an omitted input runs the tool with no arguments", async () => {
    await callRoute({ toolName: "file_list" });

    expect(runToolStandalone).toHaveBeenCalledWith("file_list", {});
  });

  test("an unregistered tool is a 404, not a server error", async () => {
    runToolStandalone.mockImplementationOnce(async (toolName: string) => {
      throw new UnknownToolError(toolName);
    });

    expect(await statusOf({ toolName: "nope" })).toBe(404);
  });

  test("a missing tool name is rejected before anything runs", async () => {
    expect(await statusOf({})).toBe(400);
    expect(runToolStandalone).not.toHaveBeenCalled();
  });

  test("a non-object input is rejected before anything runs", async () => {
    expect(await statusOf({ toolName: "file_list", input: [1, 2] })).toBe(400);
    expect(await statusOf({ toolName: "file_list", input: "x" })).toBe(400);
    expect(runToolStandalone).not.toHaveBeenCalled();
  });

  test("stays reachable only by local callers, and only with settings.write", () => {
    expect(
      route.policy?.allowedPrincipalTypes,
      "This route executes tools. Widening it past local callers would let a " +
        "gateway-proxied remote actor drive tool execution outside a " +
        "conversation, which nothing needs.",
    ).toEqual(["local"]);
    expect(route.policy?.requiredScopes).toEqual(["settings.write"]);
  });
});
