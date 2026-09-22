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

const start = jest.fn(async () => []);
const stop = jest.fn(async () => {});
const publishMcpChanged = jest.fn();
const realResourceSync =
  await import("../../runtime/sync/resource-sync-events.js");

mock.module("../manager.js", () => ({
  getMcpServerManager: () => ({
    start,
    stop,
    callTool: jest.fn(),
    getClient: () => undefined,
  }),
  stopMcpServerManager: jest.fn(async () => {}),
}));

mock.module("../../runtime/sync/resource-sync-events.js", () => ({
  ...realResourceSync,
  publishMcpChanged,
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
  start.mockReset();
  start.mockResolvedValue([]);
  stop.mockReset();
  stop.mockResolvedValue(undefined);
  publishMcpChanged.mockReset();
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

  test("publishes status only after a slow reload settles", async () => {
    let finishStop: (() => void) | undefined;
    stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );

    const reload = reloadMcpServers();
    while (!finishStop) {
      await Promise.resolve();
    }
    expect(publishMcpChanged).not.toHaveBeenCalled();

    finishStop!();
    await reload;

    expect(publishMcpChanged).toHaveBeenCalledTimes(1);
  });
});
