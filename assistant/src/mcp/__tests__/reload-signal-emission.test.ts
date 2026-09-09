/**
 * The daemon's MCP reload is what announces itself to the other processes.
 *
 * Every path that changes the server set (a config edit, the reload route, an
 * OAuth reauthentication, a plugin install) funnels through `reloadMcpServers`,
 * so signalling there covers all of them. Signalling anywhere narrower would
 * leave whichever path was missed silently stale in the schedule worker.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

mock.module("../manager.js", () => ({
  getMcpServerManager: () => ({
    start: jest.fn(async () => []),
    stop: jest.fn(async () => {}),
    callTool: jest.fn(),
    getClient: () => undefined,
  }),
  stopMcpServerManager: jest.fn(async () => {}),
}));

mock.module("../mcp-header-store.js", () => ({
  migrateLegacyMcpHeaders: async () => {},
}));

mock.module("../../plugins/mcp-servers.js", () => ({
  readPluginMcpServers: () => ({ servers: [], issues: [] }),
}));

const { getSignalsDir } = await import("../../util/platform.js");
const { MCP_RELOAD_SIGNAL_FILE } = await import("../reload-signal.js");
const { reloadMcpServers } = await import("../../daemon/mcp-reload-service.js");

const signalPath = () => join(getSignalsDir(), MCP_RELOAD_SIGNAL_FILE);

beforeEach(() => {
  rmSync(signalPath(), { force: true });
});

describe("reloadMcpServers", () => {
  test("signals the reload so other processes rebuild their own set", async () => {
    const result = await reloadMcpServers();

    expect(result.success).toBe(true);
    expect(
      existsSync(signalPath()),
      "Connections and the tools they register are per-process. A reload " +
        "that only rebuilds the daemon's leaves the schedule worker calling " +
        "servers the config no longer lists.",
    ).toBe(true);
  });
});
