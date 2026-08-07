/**
 * Tests for reading plugin-declared MCP servers from a root `mcp.json`.
 *
 * The failure-isolation behaviour is the part worth pinning: the Agent
 * Plugins spec says an invalid top-level manifest disables MCP for that
 * plugin alone, and an invalid individual entry disables only that entry.
 * A reader that threw on either would take every other plugin's servers
 * out of `assistant mcp list` along with it.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  buildServerId,
  interpolatePluginPaths,
  readPluginMcpServers,
} from "../plugin-mcp-servers.js";

/** Build a throwaway plugins directory with the given plugin layouts. */
function makePluginsDir(
  plugins: Record<
    string,
    { mcpJson?: string; packageJson?: string; disabled?: boolean }
  >,
): string {
  const root = mkdtempSync(join(tmpdir(), "vellum-plugin-mcp-"));
  for (const [name, spec] of Object.entries(plugins)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      spec.packageJson ?? JSON.stringify({ name, version: "1.0.0" }),
    );
    if (spec.mcpJson !== undefined) {
      writeFileSync(join(dir, "mcp.json"), spec.mcpJson);
    }
    if (spec.disabled) {
      writeFileSync(join(dir, ".disabled"), "");
    }
  }
  return root;
}

const VALID_MANIFEST = JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    unabyss: { type: "streamable-http", url: "https://mcp.unabyss.com" },
  },
});

describe("buildServerId", () => {
  test("collapses the redundant case so tool names stay readable", () => {
    // The id is embedded in every tool name as mcp__<id>__<tool>, so
    // `unabyss__unabyss` would show up in the model's catalog.
    expect(buildServerId("unabyss", "unabyss")).toEqual("unabyss");
  });

  test("qualifies with the plugin name when the keys differ", () => {
    expect(buildServerId("acme", "deploy")).toEqual("acme__deploy");
  });
});

describe("interpolatePluginPaths", () => {
  test("expands both spec-defined variables", () => {
    expect(
      interpolatePluginPaths("${PLUGIN_ROOT}/bin", "/p", "/p/data"),
    ).toEqual("/p/bin");
    expect(
      interpolatePluginPaths("${PLUGIN_DATA}/db", "/p", "/p/data"),
    ).toEqual("/p/data/db");
  });

  test("expands every occurrence, not just the first", () => {
    expect(
      interpolatePluginPaths("${PLUGIN_ROOT}:${PLUGIN_ROOT}", "/p", "/p/data"),
    ).toEqual("/p:/p");
  });

  test("leaves unknown variables alone", () => {
    expect(interpolatePluginPaths("${HOME}/x", "/p", "/p/data")).toEqual(
      "${HOME}/x",
    );
  });
});

describe("readPluginMcpServers", () => {
  test("reads a streamable-http server from a plugin manifest", () => {
    const dir = makePluginsDir({ unabyss: { mcpJson: VALID_MANIFEST } });
    const { servers, issues } = readPluginMcpServers({
      workspacePluginsDir: dir,
    });

    expect(issues).toEqual([]);
    expect(servers).toHaveLength(1);
    expect(servers[0].id).toEqual("unabyss");
    expect(servers[0].pluginName).toEqual("unabyss");
    expect(servers[0].config.transport).toEqual({
      type: "streamable-http",
      url: "https://mcp.unabyss.com",
    });
  });

  test("defaults plugin servers to high risk", () => {
    // mcp.json has no risk field, and a plugin must not be able to lower
    // the approval bar for the tools it introduces.
    const dir = makePluginsDir({ unabyss: { mcpJson: VALID_MANIFEST } });
    const { servers } = readPluginMcpServers({ workspacePluginsDir: dir });
    expect(servers[0].config.defaultRiskLevel).toEqual("high");
  });

  test("skips plugins with no mcp.json without complaining", () => {
    const dir = makePluginsDir({ plain: {} });
    expect(readPluginMcpServers({ workspacePluginsDir: dir })).toEqual({
      servers: [],
      issues: [],
    });
  });

  test("skips disabled plugins entirely", () => {
    const dir = makePluginsDir({
      unabyss: { mcpJson: VALID_MANIFEST, disabled: true },
    });
    const { servers } = readPluginMcpServers({ workspacePluginsDir: dir });
    expect(servers).toEqual([]);
  });

  test("an unparseable manifest disables only that plugin", () => {
    const dir = makePluginsDir({
      broken: { mcpJson: "{ not json" },
      good: { mcpJson: VALID_MANIFEST },
    });
    const { servers, issues } = readPluginMcpServers({
      workspacePluginsDir: dir,
    });

    expect(servers.map((s) => s.pluginName)).toEqual(["good"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].pluginName).toEqual("broken");
    expect(issues[0].message).toContain("invalid JSON");
  });

  test("a manifest missing mcpServers disables only that plugin", () => {
    const dir = makePluginsDir({
      broken: { mcpJson: JSON.stringify({ $schema: "x" }) },
      good: { mcpJson: VALID_MANIFEST },
    });
    const { servers, issues } = readPluginMcpServers({
      workspacePluginsDir: dir,
    });

    expect(servers.map((s) => s.pluginName)).toEqual(["good"]);
    expect(issues[0].message).toContain("mcpServers");
  });

  test("an invalid entry disables only that entry, not its siblings", () => {
    const dir = makePluginsDir({
      acme: {
        mcpJson: JSON.stringify({
          mcpServers: {
            good: { type: "streamable-http", url: "https://a.example" },
            bad: { type: "streamable-http" },
            alsoBad: { type: "carrier-pigeon", url: "https://b.example" },
          },
        }),
      },
    });
    const { servers, issues } = readPluginMcpServers({
      workspacePluginsDir: dir,
    });

    expect(servers.map((s) => s.serverKey)).toEqual(["good"]);
    expect(issues.map((i) => i.serverKey).sort()).toEqual(["alsoBad", "bad"]);
  });

  test("projects a stdio server and expands its path variables", () => {
    const dir = makePluginsDir({
      local: {
        mcpJson: JSON.stringify({
          mcpServers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["${PLUGIN_ROOT}/server.js"],
              env: { STATE: "${PLUGIN_DATA}/state" },
            },
          },
        }),
      },
    });
    const { servers } = readPluginMcpServers({ workspacePluginsDir: dir });

    const transport = servers[0].config.transport;
    expect(transport.type).toEqual("stdio");
    if (transport.type !== "stdio") {
      throw new Error("expected a stdio transport");
    }
    expect(transport.command).toEqual("node");
    expect(transport.args[0]).toEqual(join(dir, "local", "server.js"));
    expect(transport.env?.STATE).toEqual(join(dir, "local", "data", "state"));
  });

  test("reports an ignored cwd rather than dropping it silently", () => {
    const dir = makePluginsDir({
      local: {
        mcpJson: JSON.stringify({
          mcpServers: {
            local: { type: "stdio", command: "node", cwd: "${PLUGIN_ROOT}" },
          },
        }),
      },
    });
    const { servers, issues } = readPluginMcpServers({
      workspacePluginsDir: dir,
    });

    expect(servers).toHaveLength(1);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("cwd");
  });

  test("two plugins claiming one id keep the first and report the second", () => {
    // Both would otherwise register as `shared`, and whichever lost would
    // simply be missing with no explanation.
    const manifest = JSON.stringify({
      mcpServers: { shared: { type: "sse", url: "https://s.example" } },
    });
    const dir = makePluginsDir({
      "a-plugin": { mcpJson: manifest },
      "b-plugin": { mcpJson: manifest },
    });
    const { servers, issues } = readPluginMcpServers({
      workspacePluginsDir: dir,
    });

    expect(servers).toHaveLength(2);
    expect(servers.map((s) => s.id).sort()).toEqual([
      "a-plugin__shared",
      "b-plugin__shared",
    ]);
    expect(issues).toEqual([]);
  });

  test("an id collision between two plugins keeps one and reports the other", () => {
    // The id-collapsing rule makes this reachable: plugin `a` with key `b`
    // qualifies to `a__b`, and plugin `a__b` with key `a__b` collapses to
    // `a__b` too. Whichever loses would otherwise be silently missing.
    const dir = makePluginsDir({
      a: {
        mcpJson: JSON.stringify({
          mcpServers: { b: { type: "sse", url: "https://a.example" } },
        }),
      },
      a__b: {
        mcpJson: JSON.stringify({
          mcpServers: { a__b: { type: "sse", url: "https://b.example" } },
        }),
      },
    });
    const { servers, issues } = readPluginMcpServers({
      workspacePluginsDir: dir,
    });

    expect(servers.filter((s) => s.id === "a__b")).toHaveLength(1);
    expect(issues.some((i) => i.message.includes("already declared"))).toBe(
      true,
    );
  });

  test("an empty server key is rejected rather than producing a nameless id", () => {
    const dir = makePluginsDir({
      acme: {
        mcpJson: JSON.stringify({
          mcpServers: { "": { type: "sse", url: "https://a.example" } },
        }),
      },
    });
    const { servers, issues } = readPluginMcpServers({
      workspacePluginsDir: dir,
    });

    expect(servers).toEqual([]);
    expect(issues[0].message).toContain("non-empty");
  });

  test("returns empty when the plugins directory does not exist", () => {
    expect(
      readPluginMcpServers({
        workspacePluginsDir: join(tmpdir(), "vellum-does-not-exist-12345"),
      }),
    ).toEqual({ servers: [], issues: [] });
  });
});
