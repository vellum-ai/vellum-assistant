/**
 * `internal_mcp_add` writes only the transport. Policy fields (enabled,
 * risk, tool caps, allow/block lists) are not persisted.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let raw: Record<string, unknown> = {};
let saved: Record<string, unknown> | undefined;

const actualLoader = await import("../../../config/loader.js");
mock.module("../../../config/loader.js", () => ({
  ...actualLoader,
  loadRawConfig: () => raw,
  saveRawConfig: (next: Record<string, unknown>) => {
    saved = next;
  },
}));

mock.module("../../../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: async () => {},
}));

const { ROUTES } = await import("../mcp-auth-routes.js");

const addRoute = ROUTES.find((r) => r.operationId === "internal_mcp_add")!;

function addedEntry(): Record<string, unknown> {
  const mcp = saved?.mcp as { servers: Record<string, unknown> };
  return mcp.servers["srv"] as Record<string, unknown>;
}

describe("internal_mcp_add persisted shape", () => {
  beforeEach(() => {
    raw = {};
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
