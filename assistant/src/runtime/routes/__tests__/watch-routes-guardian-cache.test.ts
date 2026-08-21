/**
 * A watch session's principal lookup against a stale guardian-delivery cache.
 *
 * The cache keeps a successful read that found no binding, and a gateway-side
 * binding write does not invalidate it, so the read a session start depends on
 * has to force a refresh or a first run fails for the cache's whole TTL. The
 * guardian reader is mocked here rather than in the main watch-routes suite so
 * the substitution stays inside this file.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { GuardianDelivery } from "@vellumai/gateway-client";

let cachedResult: GuardianDelivery[] | null = null;
let freshResult: GuardianDelivery[] | null = null;
let cachedCalls = 0;
let freshCalls = 0;

// Only the two read entry points are substituted; the rest of the reader's
// surface stays real, because other modules in this graph import from it.
const realReader =
  await import("../../../contacts/guardian-delivery-reader.js");
mock.module("../../../contacts/guardian-delivery-reader.js", () => ({
  ...realReader,
  getGuardianDelivery: () => {
    cachedCalls++;
    return Promise.resolve(cachedResult);
  },
  getGuardianDeliveryFresh: () => {
    freshCalls++;
    return Promise.resolve(freshResult);
  },
  peekCachedGuardianDelivery: () => undefined,
}));

const { initializeDb } = await import("../../../persistence/db-init.js");
const { WatchSessionManager } =
  await import("../../../watch/watch-session-manager.js");
const { WatchStreamSession, resolveWatchActorPrincipalId } =
  await import("../watch-routes.js");

await initializeDb();

afterAll(() => {
  mock.restore();
});

/** The shape `guardianForChannel` matches on for the vellum binding. */
function guardian(principalId: string): GuardianDelivery {
  return {
    principalId,
    channelType: "vellum",
    status: "active",
  } as unknown as GuardianDelivery;
}

/** A socket that keeps the frame types the session sent it. */
function newSocket() {
  const types: string[] = [];
  return {
    types,
    send: (data: string) => {
      types.push((JSON.parse(data) as { type: string }).type);
    },
    close: () => {},
  };
}

/** A transcriber that opens without reaching any provider. */
function newTranscriber() {
  return {
    providerId: "deepgram" as const,
    boundaryId: "daemon-streaming" as const,
    start: async () => {},
    sendAudio: () => {},
    stop: () => {},
  };
}

describe("watch principal lookup against a stale guardian cache", () => {
  beforeEach(() => {
    cachedCalls = 0;
    freshCalls = 0;
    cachedResult = [];
    freshResult = [];
  });

  test("reads past an empty cached answer to the binding that now exists", async () => {
    cachedResult = [];
    freshResult = [guardian("guardian-just-bound")];

    expect(await resolveWatchActorPrincipalId()).toBe("guardian-just-bound");
    expect(freshCalls).toBe(1);
    expect(cachedCalls).toBe(0);
  });

  test("a session started after the binding appears reaches ready", async () => {
    // The cache still holds the empty answer from before the guardian was
    // bound, which is the state a first run starts in.
    cachedResult = [];
    freshResult = [guardian("guardian-just-bound")];

    const manager = new WatchSessionManager({
      observe: async () => ({ ok: true, axTree: "Window: Editor" }),
    });
    const ws = newSocket();
    const session = new WatchStreamSession(ws, {
      mimeType: "audio/webm",
      manager,
      resolveTranscriber: async () => newTranscriber(),
    });

    await session.start();

    // The handshake rather than the exact sequence: the session reads the
    // screen as it opens, so its capture acknowledgement lands in here too.
    expect(ws.types[0]).toBe("ready");
    expect(ws.types).not.toContain("error");
    expect(manager.isActive()).toBe(true);

    session.destroy();
  });

  test("no binding at all still fails closed", async () => {
    cachedResult = [];
    freshResult = [];

    const ws = newSocket();
    const session = new WatchStreamSession(ws, {
      mimeType: "audio/webm",
      manager: new WatchSessionManager(),
      resolveTranscriber: async () => newTranscriber(),
    });

    await session.start();

    expect(ws.types).toEqual(["error", "closed"]);
  });
});
