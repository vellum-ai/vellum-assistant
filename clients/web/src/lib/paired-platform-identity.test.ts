/**
 * Tests for `resolvePairedAssistantPlatformId`: the paired-proxy status read,
 * the lockfile persist, and the per-session cache (hits and misses alike).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { LockfileAssistant } from "@/lib/local-mode";

const UUID = "0f7c8b3e-2a41-4c1d-9b6e-1d2f3a4b5c6d";

const pairedEntry: LockfileAssistant = {
  assistantId: "paired-remote",
  cloud: "paired",
  runtimeUrl: "https://remote.example",
  hatchedAt: "2024-01-01T00:00:00Z",
};

let lockfileEntry: LockfileAssistant | undefined = pairedEntry;
let pairedGatewayUrl: string | undefined =
  "/assistant/__gateway-paired/paired-remote";
const updateLockfileAssistant = mock(async (_a: LockfileAssistant) => {});
mock.module("@/lib/local-mode", () => ({
  getLockfileAssistant: () => lockfileEntry,
  getPairedGatewayUrl: () => pairedGatewayUrl,
  updateLockfileAssistant,
}));

const fetchPlatformStatus = mock(
  async (
    _gateway: { gatewayUrl: string; actorToken: string | null },
    _id: string,
  ) => ({ assistantId: UUID }) as { assistantId: string | null } | null,
);
mock.module("@/lib/local-platform-identity", () => ({ fetchPlatformStatus }));

const {
  resetPairedPlatformIdentityCacheForTesting,
  resolvePairedAssistantPlatformId,
} = await import("@/lib/paired-platform-identity");

beforeEach(() => {
  lockfileEntry = pairedEntry;
  pairedGatewayUrl = "/assistant/__gateway-paired/paired-remote";
  fetchPlatformStatus.mockResolvedValue({ assistantId: UUID });
  updateLockfileAssistant.mockResolvedValue(undefined);
});

afterEach(() => {
  resetPairedPlatformIdentityCacheForTesting();
  fetchPlatformStatus.mockReset();
  updateLockfileAssistant.mockReset();
});

describe("resolvePairedAssistantPlatformId", () => {
  test("reads the paired daemon's status through the proxy and persists the UUID", async () => {
    await expect(
      resolvePairedAssistantPlatformId("paired-remote"),
    ).resolves.toBe(UUID);
    expect(fetchPlatformStatus).toHaveBeenCalledWith(
      {
        gatewayUrl: `${window.location.origin}/assistant/__gateway-paired/paired-remote`,
        actorToken: null,
      },
      "paired-remote",
    );
    expect(updateLockfileAssistant).toHaveBeenCalledWith({
      ...pairedEntry,
      platformAssistantId: UUID,
    });
  });

  test("resolves once per id per session", async () => {
    await resolvePairedAssistantPlatformId("paired-remote");
    await resolvePairedAssistantPlatformId("paired-remote");
    expect(fetchPlatformStatus).toHaveBeenCalledTimes(1);
    expect(updateLockfileAssistant).toHaveBeenCalledTimes(1);
  });

  test("caches a miss so an unreachable daemon is not re-asked", async () => {
    fetchPlatformStatus.mockResolvedValue(null);
    await expect(
      resolvePairedAssistantPlatformId("paired-remote"),
    ).resolves.toBeNull();
    await expect(
      resolvePairedAssistantPlatformId("paired-remote"),
    ).resolves.toBeNull();
    expect(fetchPlatformStatus).toHaveBeenCalledTimes(1);
    expect(updateLockfileAssistant).not.toHaveBeenCalled();
  });

  test("returns the persisted id without a daemon read", async () => {
    lockfileEntry = { ...pairedEntry, platformAssistantId: UUID };
    await expect(
      resolvePairedAssistantPlatformId("paired-remote"),
    ).resolves.toBe(UUID);
    expect(fetchPlatformStatus).not.toHaveBeenCalled();
  });

  test.each([
    ["no lockfile entry", () => (lockfileEntry = undefined)],
    ["no usable paired proxy", () => (pairedGatewayUrl = undefined)],
  ])("resolves null with %s", async (_l, arrange) => {
    arrange();
    await expect(
      resolvePairedAssistantPlatformId("paired-remote"),
    ).resolves.toBeNull();
    expect(fetchPlatformStatus).not.toHaveBeenCalled();
  });

  test("rejects a status id that is not a UUID", async () => {
    fetchPlatformStatus.mockResolvedValue({ assistantId: "self" });
    await expect(
      resolvePairedAssistantPlatformId("paired-remote"),
    ).resolves.toBeNull();
    expect(updateLockfileAssistant).not.toHaveBeenCalled();
  });

  test("a failed lockfile write still returns the UUID", async () => {
    updateLockfileAssistant.mockRejectedValue(new Error("disk"));
    await expect(
      resolvePairedAssistantPlatformId("paired-remote"),
    ).resolves.toBe(UUID);
  });
});
