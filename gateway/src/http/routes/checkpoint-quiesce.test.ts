import { describe, expect, test } from "bun:test";

import { IpcTransportError } from "../../ipc/assistant-client.js";
import { VELAY_FORWARDED_HEADER } from "../../velay/bridge-utils.js";
import {
  CHECKPOINT_PREPARE_IPC_METHOD,
  handleCheckpointQuiesce,
  type CheckpointQuiesceDeps,
} from "./checkpoint-quiesce.js";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://gateway.test/internal/prepare-for-checkpoint", {
    method: "POST",
    headers,
  });
}

function makeDeps(
  overrides: Partial<CheckpointQuiesceDeps> & {
    daemonResult?: unknown;
    daemonError?: Error;
    calls?: Array<{ method: string; timeoutMs?: number }>;
  } = {},
): CheckpointQuiesceDeps {
  const calls = overrides.calls ?? [];
  return {
    isPlatform: overrides.isPlatform ?? true,
    velayTunnelClient:
      "velayTunnelClient" in overrides
        ? overrides.velayTunnelClient
        : { prepareForCheckpoint: () => true },
    getSlackSocketClient: overrides.getSlackSocketClient ?? (() => null),
    callAssistant: async (method, _params, opts) => {
      calls.push({ method, timeoutMs: opts?.timeoutMs });
      if (overrides.daemonError) {
        throw overrides.daemonError;
      }
      return overrides.daemonResult ?? { ok: true, disposedSseClients: 2 };
    },
  };
}

describe("handleCheckpointQuiesce", () => {
  test("closes gateway sockets, relays to the daemon, and returns a summary", async () => {
    const calls: Array<{ method: string; timeoutMs?: number }> = [];
    let velayClosed = false;
    let slackClosed = false;
    const deps = makeDeps({
      calls,
      velayTunnelClient: {
        prepareForCheckpoint: () => {
          velayClosed = true;
          return true;
        },
      },
      getSlackSocketClient: () => ({
        prepareForCheckpoint: () => {
          slackClosed = true;
          return true;
        },
      }),
    });

    const res = await handleCheckpointQuiesce(makeRequest(), deps);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      gateway: { velayTunnelClosed: true, slackSocketClosed: true },
      daemon: { ok: true, disposedSseClients: 2 },
    });
    expect(velayClosed).toBe(true);
    expect(slackClosed).toBe(true);
    expect(calls).toEqual([
      { method: CHECKPOINT_PREPARE_IPC_METHOD, timeoutMs: 3_000 },
    ]);
  });

  test("still closes gateway sockets when the daemon IPC call fails", async () => {
    let velayClosed = false;
    const deps = makeDeps({
      daemonError: new IpcTransportError("socket not found"),
      velayTunnelClient: {
        prepareForCheckpoint: () => {
          velayClosed = true;
          return true;
        },
      },
    });

    const res = await handleCheckpointQuiesce(makeRequest(), deps);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      daemon: { ok: boolean; error: string };
    };
    expect(body.ok).toBe(true);
    expect(body.daemon.ok).toBe(false);
    expect(body.daemon.error).toContain("socket not found");
    expect(velayClosed).toBe(true);
  });

  test("tolerates a missing velay client and slack client", async () => {
    const deps = makeDeps({
      velayTunnelClient: undefined,
      getSlackSocketClient: () => null,
    });

    const res = await handleCheckpointQuiesce(makeRequest(), deps);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gateway: { velayTunnelClosed: boolean; slackSocketClosed: boolean };
    };
    expect(body.gateway).toEqual({
      velayTunnelClosed: false,
      slackSocketClosed: false,
    });
  });

  test("404s on non-platform deployments without touching any socket", async () => {
    const calls: Array<{ method: string }> = [];
    let velayClosed = false;
    const deps = makeDeps({
      calls,
      isPlatform: false,
      velayTunnelClient: {
        prepareForCheckpoint: () => {
          velayClosed = true;
          return true;
        },
      },
    });

    const res = await handleCheckpointQuiesce(makeRequest(), deps);

    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
    expect(velayClosed).toBe(false);
  });

  test("rejects Velay-bridged requests", async () => {
    const calls: Array<{ method: string }> = [];
    let velayClosed = false;
    const deps = makeDeps({
      calls,
      velayTunnelClient: {
        prepareForCheckpoint: () => {
          velayClosed = true;
          return true;
        },
      },
    });

    const res = await handleCheckpointQuiesce(
      makeRequest({ [VELAY_FORWARDED_HEADER]: "1" }),
      deps,
    );

    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(velayClosed).toBe(false);
  });
});
