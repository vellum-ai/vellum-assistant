/**
 * The global MCP tool cap used to consume the budget in insertion order,
 * so later servers could lose every tool when earlier ones filled the
 * 50-tool ceiling. Selection is a deterministic round-robin by server id.
 */

import { describe, expect, test } from "bun:test";

import {
  MCP_GLOBAL_MAX_TOOLS,
  MCP_MAX_TOOLS_PER_SERVER,
} from "../../config/schemas/mcp.js";
import { applyMcpToolCaps, resolveMcpGlobalMaxTools } from "../tool-caps.js";

function toolsNamed(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-tool-${i}`);
}

function setsOf(servers: Array<{ serverId: string; tools: string[] }>) {
  return new Map(servers.map((server) => [server.serverId, server.tools]));
}

describe("applyMcpToolCaps", () => {
  test("keeps every tool when the discovered set is under both caps", () => {
    const result = applyMcpToolCaps([
      { serverId: "alpha", tools: toolsNamed("alpha", 3) },
      { serverId: "beta", tools: toolsNamed("beta", 2) },
    ]);

    expect(result.keptToolCount).toBe(5);
    expect(result.droppedToolCount).toBe(0);
    expect(result.servers.map((server) => server.tools.length)).toEqual([3, 2]);
  });

  test("applies the per-server cap before the global budget", () => {
    const result = applyMcpToolCaps(
      [{ serverId: "busy", tools: toolsNamed("busy", 8) }],
      { perServerMax: 3, globalMax: 50 },
    );

    expect(result.servers[0]?.tools).toEqual(toolsNamed("busy", 3));
    expect(result.decisions[0]?.droppedByPerServerCap).toBe(5);
    expect(result.decisions[0]?.droppedByGlobalCap).toBe(0);
  });

  test("eight servers totaling about 50 tools do not starve later servers", () => {
    const servers = Array.from({ length: 8 }, (_, i) => ({
      serverId: `server-${String(i + 1).padStart(2, "0")}`,
      tools: toolsNamed(`s${i + 1}`, 10),
    }));

    const result = applyMcpToolCaps(servers, {
      perServerMax: MCP_MAX_TOOLS_PER_SERVER,
      globalMax: MCP_GLOBAL_MAX_TOOLS,
    });

    expect(result.discoveredToolCount).toBe(80);
    expect(result.keptToolCount).toBe(MCP_GLOBAL_MAX_TOOLS);
    expect(
      result.servers.every((server) => server.tools.length > 0),
      "Every connected server keeps at least one tool under a 50-tool global cap.",
    ).toBe(true);
    expect(result.servers[5]?.tools.length).toBeGreaterThan(0);
    expect(result.servers[6]?.tools.length).toBeGreaterThan(0);
    expect(result.servers[7]?.tools.length).toBeGreaterThan(0);
  });

  test("reordering servers does not change which tools are kept", () => {
    const forward = Array.from({ length: 8 }, (_, i) => ({
      serverId: `server-${String(i + 1).padStart(2, "0")}`,
      tools: toolsNamed(`s${i + 1}`, 10),
    }));
    const reversed = [...forward].reverse();

    const a = applyMcpToolCaps(forward, { globalMax: 50, perServerMax: 20 });
    const b = applyMcpToolCaps(reversed, { globalMax: 50, perServerMax: 20 });

    expect(setsOf(a.servers)).toEqual(setsOf(b.servers));
    expect(
      a.servers.every((server) => server.tools.length > 0),
    ).toBe(true);
    expect(
      b.servers.every((server) => server.tools.length > 0),
    ).toBe(true);
  });

  test("does not use insertion order to empty a later server", () => {
    const result = applyMcpToolCaps(
      [
        { serverId: "early", tools: toolsNamed("early", 10) },
        { serverId: "mid", tools: toolsNamed("mid", 10) },
        { serverId: "late", tools: toolsNamed("late", 10) },
      ],
      { globalMax: 12, perServerMax: 20 },
    );

    expect(result.servers.find((s) => s.serverId === "late")?.tools.length).toBe(
      4,
    );
    expect(result.servers.find((s) => s.serverId === "early")?.tools.length).toBe(
      4,
    );
    expect(result.servers.find((s) => s.serverId === "mid")?.tools.length).toBe(
      4,
    );
  });

  test("honors a workspace global-max override", () => {
    const servers = Array.from({ length: 8 }, (_, i) => ({
      serverId: `server-${String(i + 1).padStart(2, "0")}`,
      tools: toolsNamed(`s${i + 1}`, 10),
    }));

    const result = applyMcpToolCaps(servers, { globalMax: 80, perServerMax: 20 });

    expect(result.keptToolCount).toBe(80);
    expect(result.droppedToolCount).toBe(0);
    expect(result.servers.every((server) => server.tools.length === 10)).toBe(
      true,
    );
  });
});

describe("resolveMcpGlobalMaxTools", () => {
  test("uses the shipped default when the workspace omits the override", () => {
    expect(resolveMcpGlobalMaxTools()).toBe(MCP_GLOBAL_MAX_TOOLS);
    expect(resolveMcpGlobalMaxTools({})).toBe(MCP_GLOBAL_MAX_TOOLS);
  });

  test("uses tools.mcpGlobalMaxTools from config.json when set", () => {
    expect(resolveMcpGlobalMaxTools({ mcpGlobalMaxTools: 80 })).toBe(80);
    expect(resolveMcpGlobalMaxTools({ mcpGlobalMaxTools: 1 })).toBe(1);
  });
});
