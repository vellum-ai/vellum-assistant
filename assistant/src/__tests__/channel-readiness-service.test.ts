import { beforeEach, describe, expect, test } from "bun:test";

import type { ChannelId } from "../channels/types.js";
import {
  ChannelReadinessService,
  REMOTE_TTL_MS,
} from "../runtime/channel-readiness-service.js";
import type {
  ChannelProbe,
  ReadinessCheckResult,
} from "../runtime/channel-readiness-types.js";

// ── Test helpers ────────────────────────────────────────────────────────────

function makeProbe(
  channel: ChannelId,
  localResults: ReadinessCheckResult[],
  remoteResults?: ReadinessCheckResult[],
): ChannelProbe & { localCallCount: number; remoteCallCount: number } {
  const probe = {
    channel,
    localCallCount: 0,
    remoteCallCount: 0,
    runLocalChecks(): ReadinessCheckResult[] {
      probe.localCallCount++;
      return localResults;
    },
    ...(remoteResults !== undefined
      ? {
          async runRemoteChecks(): Promise<ReadinessCheckResult[]> {
            probe.remoteCallCount++;
            return remoteResults;
          },
        }
      : {}),
  };
  return probe;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ChannelReadinessService", () => {
  let service: ChannelReadinessService;

  beforeEach(() => {
    service = new ChannelReadinessService();
  });

  test("local checks run on every call (no caching of local results)", async () => {
    const probe = makeProbe("voice", [
      { name: "creds", passed: true, message: "ok" },
    ]);
    service.registerProbe(probe);

    await service.getReadiness("voice");
    await service.getReadiness("voice");

    expect(probe.localCallCount).toBe(2);
  });

  test("cache miss runs local checks and returns snapshot", async () => {
    const probe = makeProbe("voice", [
      { name: "creds", passed: true, message: "ok" },
      { name: "phone", passed: false, message: "missing" },
    ]);
    service.registerProbe(probe);

    const [snapshot] = await service.getReadiness("voice");

    expect(probe.localCallCount).toBe(1);
    expect(snapshot.channel).toBe("voice");
    expect(snapshot.ready).toBe(false);
    expect(snapshot.localChecks).toHaveLength(2);
    expect(snapshot.reasons).toEqual([{ code: "phone", text: "missing" }]);
  });

  test("includeRemote=true runs remote checks on cache miss", async () => {
    const probe = makeProbe(
      "voice",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: true, message: "remote ok" }],
    );
    service.registerProbe(probe);

    const [snapshot] = await service.getReadiness("voice", true);

    expect(probe.remoteCallCount).toBe(1);
    expect(snapshot.remoteChecks).toHaveLength(1);
    expect(snapshot.remoteChecks![0].passed).toBe(true);
  });

  test("cached remote checks reused within TTL", async () => {
    const probe = makeProbe(
      "voice",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: true, message: "remote ok" }],
    );
    service.registerProbe(probe);

    // First call populates cache
    await service.getReadiness("voice", true);
    expect(probe.remoteCallCount).toBe(1);

    // Second call within TTL should reuse cache
    const [snapshot] = await service.getReadiness("voice", true);
    expect(probe.remoteCallCount).toBe(1);
    expect(snapshot.remoteChecks).toHaveLength(1);
  });

  test("stale cache triggers remote check re-run", async () => {
    const probe = makeProbe(
      "voice",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: true, message: "remote ok" }],
    );
    service.registerProbe(probe);

    // First call
    await service.getReadiness("voice", true);
    expect(probe.remoteCallCount).toBe(1);

    // Manually age the cached snapshot beyond TTL
    const cached = (
      service as unknown as {
        snapshots: Map<string, { checkedAt: number }>;
      }
    ).snapshots.get("sms::__default__")!;
    cached.checkedAt = Date.now() - REMOTE_TTL_MS - 1;

    // Second call should re-run remote checks
    await service.getReadiness("voice", true);
    expect(probe.remoteCallCount).toBe(2);
  });

  test("invalidateChannel clears cache for specific channel", async () => {
    const probe = makeProbe(
      "voice",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: true, message: "remote ok" }],
    );
    service.registerProbe(probe);

    await service.getReadiness("voice", true);
    expect(probe.remoteCallCount).toBe(1);

    service.invalidateChannel("voice");

    // After invalidation, remote checks should run again
    await service.getReadiness("voice", true);
    expect(probe.remoteCallCount).toBe(2);
  });

  test("invalidateAll clears all cached snapshots", async () => {
    const smsProbe = makeProbe(
      "voice",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api", passed: true, message: "ok" }],
    );
    const telegramProbe = makeProbe(
      "telegram",
      [{ name: "token", passed: true, message: "ok" }],
      [{ name: "webhook", passed: true, message: "ok" }],
    );
    service.registerProbe(smsProbe);
    service.registerProbe(telegramProbe);

    await service.getReadiness(undefined, true);
    expect(smsProbe.remoteCallCount).toBe(1);
    expect(telegramProbe.remoteCallCount).toBe(1);

    service.invalidateAll();

    await service.getReadiness(undefined, true);
    expect(smsProbe.remoteCallCount).toBe(2);
    expect(telegramProbe.remoteCallCount).toBe(2);
  });

  test("unknown channel returns unsupported_channel reason", async () => {
    // Cast to exercise runtime handling of an unrecognized channel value
    const [snapshot] = await service.getReadiness(
      "carrier_pigeon" as ChannelId,
    );

    expect(snapshot.channel).toBe("carrier_pigeon" as ChannelId);
    expect(snapshot.ready).toBe(false);
    expect(snapshot.reasons).toEqual([
      {
        code: "unsupported_channel",
        text: "Channel carrier_pigeon is not supported",
      },
    ]);
    expect(snapshot.localChecks).toHaveLength(0);
  });

  test("all checks passing yields ready=true", async () => {
    const probe = makeProbe("telegram", [
      { name: "a", passed: true, message: "ok" },
      { name: "b", passed: true, message: "ok" },
    ]);
    service.registerProbe(probe);

    const [snapshot] = await service.getReadiness("telegram");

    expect(snapshot.ready).toBe(true);
    expect(snapshot.reasons).toHaveLength(0);
  });

  test("getReadiness with no channel returns all registered channels", async () => {
    service.registerProbe(
      makeProbe("voice", [{ name: "a", passed: true, message: "ok" }]),
    );
    service.registerProbe(
      makeProbe("telegram", [{ name: "b", passed: true, message: "ok" }]),
    );

    const snapshots = await service.getReadiness();

    expect(snapshots).toHaveLength(2);
    const channels = snapshots.map((s) => s.channel).sort();
    expect(channels).toEqual(["voice", "telegram"]);
  });

  test("cached remote checks preserve original checkedAt (TTL not reset on reuse)", async () => {
    const probe = makeProbe(
      "voice",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: true, message: "remote ok" }],
    );
    service.registerProbe(probe);

    // First call populates cache with freshly fetched remote checks
    const [first] = await service.getReadiness("voice", true);
    const originalCheckedAt = first.checkedAt;
    expect(probe.remoteCallCount).toBe(1);

    // Second call within TTL reuses cache — checkedAt must stay at the original value
    const [second] = await service.getReadiness("voice", true);
    expect(probe.remoteCallCount).toBe(1);
    expect(second.checkedAt).toBe(originalCheckedAt);
  });

  test("includeRemote runs remote checks when cache exists without remote data", async () => {
    const probe = makeProbe(
      "voice",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: true, message: "remote ok" }],
    );
    service.registerProbe(probe);

    // First call without includeRemote — cache has no remote data
    await service.getReadiness("voice", false);
    expect(probe.remoteCallCount).toBe(0);

    // Second call with includeRemote — should run remote checks even though
    // the cached snapshot exists (because it has no remoteChecks)
    const [snapshot] = await service.getReadiness("voice", true);
    expect(probe.remoteCallCount).toBe(1);
    expect(snapshot.remoteChecks).toHaveLength(1);
    expect(snapshot.remoteChecks![0].passed).toBe(true);
  });

  test("failed remote check makes channel not ready", async () => {
    const probe = makeProbe(
      "voice",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: false, message: "API unreachable" }],
    );
    service.registerProbe(probe);

    const [snapshot] = await service.getReadiness("voice", true);

    expect(snapshot.ready).toBe(false);
    expect(snapshot.reasons).toEqual([
      { code: "api_check", text: "API unreachable" },
    ]);
  });

  test("fresh cached remote failures do not affect local-only readiness", async () => {
    const probe = makeProbe(
      "voice",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: false, message: "API unreachable" }],
    );
    service.registerProbe(probe);

    // Prime remote cache with a failing check
    await service.getReadiness("voice", true);

    // Immediately call with includeRemote=false (cache is still fresh within TTL).
    // The cached remote failure should be surfaced for visibility but must NOT
    // affect readiness when the caller explicitly opted out of remote checks.
    const [snapshot] = await service.getReadiness("voice", false);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.reasons).toEqual([]);
    // Remote checks are still visible for informational purposes
    expect(snapshot.remoteChecks).toHaveLength(1);
    expect(snapshot.remoteChecks![0].passed).toBe(false);
  });

  test("stale cached remote failures do not affect local-only readiness", async () => {
    const probe = makeProbe(
      "voice",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: false, message: "API unreachable" }],
    );
    service.registerProbe(probe);

    // Prime remote cache with a failing check
    await service.getReadiness("voice", true);

    // Age snapshot beyond TTL so remote checks are stale
    const cached = (
      service as unknown as {
        snapshots: Map<string, { checkedAt: number }>;
      }
    ).snapshots.get("sms::__default__")!;
    cached.checkedAt = Date.now() - REMOTE_TTL_MS - 1;

    // Local-only call should not be blocked by stale remote failure
    const [snapshot] = await service.getReadiness("voice", false);
    expect(snapshot.stale).toBe(true);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.reasons).toEqual([]);
  });

  test("remote cache uses fixed internal scope (no per-assistantId scoping)", async () => {
    const probe = makeProbe(
      "voice",
      [{ name: "local", passed: true, message: "ok" }],
      [{ name: "remote", passed: true, message: "ok" }],
    );
    service.registerProbe(probe);

    // All calls share the same cache key since there is no assistantId dimension
    await service.getReadiness("voice", true);
    await service.getReadiness("voice", true);

    expect(probe.remoteCallCount).toBe(1);
  });
});
