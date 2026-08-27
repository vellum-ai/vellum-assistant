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
mock.module("@/lib/local-platform-identity", () => ({
  fetchPlatformStatus,
  isUuid: (value: string) => /^[0-9a-f-]{36}$/i.test(value),
}));

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

  test("a re-pair to another gateway probes again", async () => {
    await resolvePairedAssistantPlatformId("paired-remote");
    lockfileEntry = { ...pairedEntry, runtimeUrl: "https://new.example.com" };
    await resolvePairedAssistantPlatformId("paired-remote");
    expect(fetchPlatformStatus).toHaveBeenCalledTimes(2);
  });

  test("resolves once per id per session", async () => {
    await resolvePairedAssistantPlatformId("paired-remote");
    await resolvePairedAssistantPlatformId("paired-remote");
    expect(fetchPlatformStatus).toHaveBeenCalledTimes(1);
    expect(updateLockfileAssistant).toHaveBeenCalledTimes(1);
  });

  test("a miss is not cached, so a recovered daemon is asked again", async () => {
    fetchPlatformStatus.mockResolvedValueOnce(null);
    await expect(
      resolvePairedAssistantPlatformId("paired-remote"),
    ).resolves.toBeNull();
    expect(updateLockfileAssistant).not.toHaveBeenCalled();
    await expect(
      resolvePairedAssistantPlatformId("paired-remote"),
    ).resolves.toBe(UUID);
    expect(fetchPlatformStatus).toHaveBeenCalledTimes(2);
  });

  test("concurrent asks share one in-flight probe", async () => {
    await Promise.all([
      resolvePairedAssistantPlatformId("paired-remote"),
      resolvePairedAssistantPlatformId("paired-remote"),
    ]);
    expect(fetchPlatformStatus).toHaveBeenCalledTimes(1);
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

  test("a rename during the request keeps the new name and gains the UUID", async () => {
    fetchPlatformStatus.mockImplementation(async () => {
      lockfileEntry = { ...pairedEntry, name: "Renamed" };
      return { assistantId: UUID };
    });
    await expect(
      resolvePairedAssistantPlatformId("paired-remote"),
    ).resolves.toBe(UUID);
    expect(updateLockfileAssistant).toHaveBeenCalledWith({
      ...pairedEntry,
      name: "Renamed",
      platformAssistantId: UUID,
    });
  });

  test.each([
    ["removed", () => (lockfileEntry = undefined)],
    [
      "no longer paired",
      () => (lockfileEntry = { ...pairedEntry, cloud: "local" }),
    ],
    [
      "retargeted",
      () =>
        (lockfileEntry = {
          ...pairedEntry,
          runtimeUrl: "https://other.example",
        }),
    ],
  ])(
    "skips the write and resolves null when the entry is %s mid-request",
    async (_l, arrange) => {
      fetchPlatformStatus.mockImplementation(async () => {
        arrange();
        return { assistantId: UUID };
      });
      await expect(
        resolvePairedAssistantPlatformId("paired-remote"),
      ).resolves.toBeNull();
      expect(updateLockfileAssistant).not.toHaveBeenCalled();
    },
  );

  test("a failed lockfile write still returns the UUID", async () => {
    updateLockfileAssistant.mockRejectedValue(new Error("disk"));
    await expect(
      resolvePairedAssistantPlatformId("paired-remote"),
    ).resolves.toBe(UUID);
  });
});
