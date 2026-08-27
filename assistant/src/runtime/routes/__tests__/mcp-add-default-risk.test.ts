/**
 * `internal_mcp_add` must not freeze a risk level into the entry it writes.
 *
 * The shipped default lives in `McpServerConfigSchema`, which parses
 * `config.json` on every load. An entry that carries no `defaultRiskLevel`
 * therefore tracks that default; one that carries an explicit level keeps it.
 * Writing a level the caller never asked for would pin every added server to
 * whatever the default happened to be on the day it was added.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { McpServerConfigSchema } from "../../../config/schemas/mcp.js";
import { BadRequestError } from "../errors.js";

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

describe("internal_mcp_add risk level", () => {
  beforeEach(() => {
    raw = {};
    saved = undefined;
  });

  test("omits defaultRiskLevel when the caller names no risk", async () => {
    await addRoute.handler({
      body: {
        name: "srv",
        transportType: "streamable-http",
        url: "https://example.com/mcp",
      },
    });

    const entry = addedEntry();
    expect(entry).not.toHaveProperty("defaultRiskLevel");
    expect(McpServerConfigSchema.parse(entry).defaultRiskLevel).toBe("medium");
  });

  test("persists an explicit risk level", async () => {
    await addRoute.handler({
      body: {
        name: "srv",
        transportType: "streamable-http",
        url: "https://example.com/mcp",
        risk: "high",
      },
    });

    expect(addedEntry().defaultRiskLevel).toBe("high");
  });

  test("rejects an unknown risk level", async () => {
    await expect(
      addRoute.handler({
        body: {
          name: "srv",
          transportType: "streamable-http",
          url: "https://example.com/mcp",
          risk: "extreme",
        },
      }),
    ).rejects.toThrow(BadRequestError);
    expect(saved).toBeUndefined();
  });
});
