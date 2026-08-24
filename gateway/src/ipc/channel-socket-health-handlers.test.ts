import { describe, expect, test } from "bun:test";

import { createChannelSocketHealthRoutes } from "./channel-socket-health-handlers.js";

function route(sources: Parameters<typeof createChannelSocketHealthRoutes>[0]) {
  const [only] = createChannelSocketHealthRoutes(sources);
  return (channel: string) => only.handler({ channel });
}

describe("channel_socket_health", () => {
  test("reports a live connection with its last proof of liveness", async () => {
    const call = route({
      slack: () => ({
        getConnectionHealth: () => ({
          connected: true,
          lastLivenessAt: 1_700_000_000_000,
        }),
      }),
    });

    expect(await call("slack")).toEqual({
      channel: "slack",
      status: "connected",
      lastLivenessAt: 1_700_000_000_000,
    });
  });

  test("omits the timestamp when nothing has proved liveness yet", async () => {
    // A connection's first keepalive is a full interval after it opens, so
    // this is the normal state of a healthy reconnect, not a fault.
    const call = route({
      slack: () => ({
        getConnectionHealth: () => ({
          connected: true,
          lastLivenessAt: undefined,
        }),
      }),
    });

    expect(await call("slack")).toEqual({
      channel: "slack",
      status: "connected",
    });
  });

  test("reports a running client with no live socket as disconnected", async () => {
    const call = route({
      slack: () => ({
        getConnectionHealth: () => ({
          connected: false,
          lastLivenessAt: undefined,
        }),
      }),
    });

    expect(await call("slack")).toMatchObject({ status: "disconnected" });
  });

  test("distinguishes an absent client from a dead one", async () => {
    // No client means no credentials, which the local credential checks
    // already report. Calling that "disconnected" would double-report a
    // channel the user never set up as a channel that broke.
    const call = route({ slack: () => null });

    expect(await call("slack")).toEqual({
      channel: "slack",
      status: "not_configured",
    });
  });

  test("a channel with no gateway-owned socket is unsupported", async () => {
    // Telegram's ingress is a webhook; its delivery health is a property of a
    // registration the daemon reads directly, not of a socket held here.
    const call = route({ slack: () => null });

    expect(await call("telegram")).toEqual({
      channel: "telegram",
      status: "unsupported",
    });
  });

  test("reads the client through the getter on every call", async () => {
    // Clients are torn down and rebuilt on a credential change, so a captured
    // reference would keep answering for a client that is no longer live.
    let current: { getConnectionHealth: () => never } | null = null;
    const call = route({ slack: () => current });

    expect(await call("slack")).toMatchObject({ status: "not_configured" });

    current = {
      getConnectionHealth: () =>
        ({ connected: true, lastLivenessAt: undefined }) as never,
    };
    expect(await call("slack")).toMatchObject({ status: "connected" });
  });
});
