import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let stopHook: (() => Promise<void>) | undefined;
const starts: string[][] = [];
const strictStops: boolean[] = [];
mock.module("../../mcp/manager.js", () => ({
  getMcpServerManager: () => ({
    stop: async (options: { requireCleanup?: boolean }) => {
      strictStops.push(options.requireCleanup ?? false);
      await stopHook?.();
    },
    start: async (config: { servers: Record<string, unknown> }) => {
      starts.push(Object.keys(config.servers).sort());
      return [];
    },
  }),
}));
mock.module("../../mcp/mcp-header-store.js", () => ({
  migrateLegacyMcpHeaders: async () => {},
}));
mock.module("../../plugins/mcp-servers.js", () => ({
  readPluginMcpServers: () => ({ servers: [], issues: [] }),
}));
const signal = mock(() => {});
const publishMcpChanged = mock(async () => {});
mock.module("../../mcp/sync.js", () => ({ publishMcpChanged }));
mock.module("../../mcp/reload-signal.js", () => ({
  signalMcpReloaded: signal,
}));
const { reloadMcpServers } = await import("../mcp-reload-service.js");

function configure(ids: string[]) {
  setConfig("mcp", {
    servers: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          transport: {
            type: "streamable-http",
            url: `https://${id}.example.com/mcp`,
          },
        },
      ]),
    ),
  });
}

beforeEach(() => {
  starts.length = 0;
  strictStops.length = 0;
  stopHook = undefined;
  signal.mockClear();
  publishMcpChanged.mockClear();
});

describe("MCP reload convergence", () => {
  test("remove and add during a reload converge to the final saved server set", async () => {
    configure(["removed", "retained"]);
    const stopped = deferred();
    const release = deferred();
    let first = true;
    stopHook = async () => {
      if (first) {
        first = false;
        stopped.resolve();
        await release.promise;
      }
    };
    const initial = reloadMcpServers();
    await stopped.promise;
    configure(["retained"]);
    const removal = reloadMcpServers({ requireCleanup: true });
    configure(["added", "retained"]);
    const addition = reloadMcpServers();
    expect(removal).toBe(initial);
    expect(addition).toBe(initial);
    release.resolve();
    const final = await removal;
    expect(strictStops).toEqual([false, true]);
    expect(starts).toEqual([
      ["removed", "retained"],
      ["added", "retained"],
    ]);
    expect(final.servers?.map((server) => server.id).sort()).toEqual([
      "added",
      "retained",
    ]);
  });

  test("completion signals workers without claiming an acknowledgement", async () => {
    configure(["example"]);
    const result = await reloadMcpServers();
    expect(result.success).toBe(true);
    expect(signal).toHaveBeenCalledTimes(1);
    expect(publishMcpChanged).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty("workersStopped");
  });

  test("failed strict cleanup invalidates rows after runtime teardown settles", async () => {
    configure(["example"]);
    const stopped = deferred();
    const release = deferred();
    stopHook = async () => {
      stopped.resolve();
      await release.promise;
      throw new Error("connection close failed");
    };
    const reload = reloadMcpServers({ requireCleanup: true });
    await stopped.promise;
    expect(publishMcpChanged).not.toHaveBeenCalled();
    release.resolve();
    expect(await reload).toEqual({
      success: false,
      error: "connection close failed",
    });
    expect(publishMcpChanged).toHaveBeenCalledTimes(1);
    expect(signal).not.toHaveBeenCalled();
    expect(starts).toEqual([]);
  });

  test("a request during completion starts a reload for the latest configuration", async () => {
    configure(["initial"]);
    let queued: Promise<unknown> | undefined;
    const requested = deferred();
    publishMcpChanged.mockImplementationOnce(async () => {
      // Arrive between the final loop check and a separately chained cleanup.
      queueMicrotask(() =>
        queueMicrotask(() =>
          queueMicrotask(() => {
            configure(["latest"]);
            queued = reloadMcpServers();
            requested.resolve();
          }),
        ),
      );
    });
    const initial = reloadMcpServers();
    await requested.promise;
    await Promise.all([initial, queued]);
    expect(starts).toEqual([["initial"], ["latest"]]);
  });
});
