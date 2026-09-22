/**
 * `internal_mcp_add` writes only the transport into workspace mcp.json.
 * Policy fields (enabled, risk, tool caps, allow/block lists) are not
 * persisted.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let stored: { servers: Record<string, { transport: Record<string, unknown> }> } =
  { servers: {} };
let saved:
  | { servers: Record<string, { transport: Record<string, unknown> }> }
  | undefined;

mock.module("../../../mcp/workspace-mcp-config.js", () => ({
  loadWorkspaceMcpConfig: () => stored,
  saveWorkspaceMcpConfig: (next: {
    servers: Record<string, { transport: Record<string, unknown> }>;
  }) => {
    saved = next;
    stored = next;
  },
}));

mock.module("../../../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: async () => {},
}));

const { ROUTES } = await import("../mcp-auth-routes.js");

const addRoute = ROUTES.find((r) => r.operationId === "internal_mcp_add")!;

function addedEntry(): Record<string, unknown> {
  return saved!.servers["srv"] as Record<string, unknown>;
}

describe("internal_mcp_add persisted shape", () => {
  beforeEach(() => {
    stored = { servers: {} };
    saved = undefined;
  });

  test("writes transport only", async () => {
    await addRoute.handler({
      body: {
        name: "srv",
        transportType: "streamable-http",
        url: "https://example.com/mcp",
      },
    });

    expect(addedEntry()).toEqual({
      transport: { type: "streamable-http", url: "https://example.com/mcp" },
    });
  });

  test("ignores leftover risk and disabled fields on the request", async () => {
    await addRoute.handler({
      body: {
        name: "srv",
        transportType: "streamable-http",
        url: "https://example.com/mcp",
        risk: "high",
        disabled: true,
      },
    });

    expect(addedEntry()).toEqual({
      transport: { type: "streamable-http", url: "https://example.com/mcp" },
    });
  });
});
