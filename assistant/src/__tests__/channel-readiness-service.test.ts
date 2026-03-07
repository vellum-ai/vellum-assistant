import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

let mockTwilioPhoneNumberEnv: string | undefined;
let mockRawConfig: Record<string, unknown> | undefined;
let mockSecureKeys: Record<string, string>;
let mockHasTwilioCredentials: boolean;
let mockGatewayHealth = {
  target: "http://127.0.0.1:7830",
  healthy: true,
  localDeployment: true,
  error: undefined as string | undefined,
};

mock.module("../calls/twilio-rest.js", () => ({
  getPhoneNumberSid: async () => null,
  getTollFreeVerificationStatus: async () => null,
  getTwilioCredentials: () => ({
    accountSid: "AC_test",
    authToken: "test-auth-token",
  }),
  hasTwilioCredentials: () => mockHasTwilioCredentials,
}));

mock.module("../channels/config.js", () => ({
  getChannelInvitePolicy: () => ({
    codeRedemptionEnabled: true,
  }),
}));

mock.module("../config/env.js", () => ({
  getTwilioPhoneNumberEnv: () => mockTwilioPhoneNumberEnv,
}));

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => mockRawConfig,
  getConfig: () => ({
    whatsapp: {
      phoneNumber: "",
    },
  }),
}));

mock.module("../email/service.js", () => ({
  getEmailService: () => ({
    getPrimaryInboxAddress: async () => undefined,
  }),
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (key: string) => mockSecureKeys[key] ?? null,
}));

mock.module("../runtime/channel-invite-transports/whatsapp.js", () => ({
  resolveWhatsAppDisplayNumber: () => "",
}));

import type { ChannelId } from "../channels/types.js";
import {
  ChannelReadinessService,
  createReadinessService,
  REMOTE_TTL_MS,
} from "../runtime/channel-readiness-service.js";
import type {
  ChannelProbe,
  ReadinessCheckResult,
} from "../runtime/channel-readiness-types.js";
import * as localGatewayHealth from "../runtime/local-gateway-health.js";

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
    mockTwilioPhoneNumberEnv = undefined;
    mockRawConfig = undefined;
    mockSecureKeys = {};
    mockHasTwilioCredentials = false;
    mockGatewayHealth = {
      target: "http://127.0.0.1:7830",
      healthy: true,
      localDeployment: true,
      error: undefined,
    };
  });

  test("local checks run on every call (no caching of local results)", async () => {
    const probe = makeProbe("sms", [
      { name: "creds", passed: true, message: "ok" },
    ]);
    service.registerProbe(probe);

    await service.getReadiness("sms");
    await service.getReadiness("sms");

    expect(probe.localCallCount).toBe(2);
  });

  test("cache miss runs local checks and returns snapshot", async () => {
    const probe = makeProbe("sms", [
      { name: "creds", passed: true, message: "ok" },
      { name: "phone", passed: false, message: "missing" },
    ]);
    service.registerProbe(probe);

    const [snapshot] = await service.getReadiness("sms");

    expect(probe.localCallCount).toBe(1);
    expect(snapshot.channel).toBe("sms");
    expect(snapshot.ready).toBe(false);
    expect(snapshot.localChecks).toHaveLength(2);
    expect(snapshot.reasons).toEqual([{ code: "phone", text: "missing" }]);
  });

  test("includeRemote=true runs remote checks on cache miss", async () => {
    const probe = makeProbe(
      "sms",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: true, message: "remote ok" }],
    );
    service.registerProbe(probe);

    const [snapshot] = await service.getReadiness("sms", true);

    expect(probe.remoteCallCount).toBe(1);
    expect(snapshot.remoteChecks).toHaveLength(1);
    expect(snapshot.remoteChecks![0].passed).toBe(true);
  });

  test("cached remote checks reused within TTL", async () => {
    const probe = makeProbe(
      "sms",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: true, message: "remote ok" }],
    );
    service.registerProbe(probe);

    // First call populates cache
    await service.getReadiness("sms", true);
    expect(probe.remoteCallCount).toBe(1);

    // Second call within TTL should reuse cache
    const [snapshot] = await service.getReadiness("sms", true);
    expect(probe.remoteCallCount).toBe(1);
    expect(snapshot.remoteChecks).toHaveLength(1);
  });

  test("stale cache triggers remote check re-run", async () => {
    const probe = makeProbe(
      "sms",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: true, message: "remote ok" }],
    );
    service.registerProbe(probe);

    // First call
    await service.getReadiness("sms", true);
    expect(probe.remoteCallCount).toBe(1);

    // Manually age the cached snapshot beyond TTL
    const cached = (
      service as unknown as {
        snapshots: Map<string, { checkedAt: number }>;
      }
    ).snapshots.get("sms::__default__")!;
    cached.checkedAt = Date.now() - REMOTE_TTL_MS - 1;

    // Second call should re-run remote checks
    await service.getReadiness("sms", true);
    expect(probe.remoteCallCount).toBe(2);
  });

  test("invalidateChannel clears cache for specific channel", async () => {
    const probe = makeProbe(
      "sms",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: true, message: "remote ok" }],
    );
    service.registerProbe(probe);

    await service.getReadiness("sms", true);
    expect(probe.remoteCallCount).toBe(1);

    service.invalidateChannel("sms");

    // After invalidation, remote checks should run again
    await service.getReadiness("sms", true);
    expect(probe.remoteCallCount).toBe(2);
  });

  test("invalidateAll clears all cached snapshots", async () => {
    const smsProbe = makeProbe(
      "sms",
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
      makeProbe("sms", [{ name: "a", passed: true, message: "ok" }]),
    );
    service.registerProbe(
      makeProbe("telegram", [{ name: "b", passed: true, message: "ok" }]),
    );

    const snapshots = await service.getReadiness();

    expect(snapshots).toHaveLength(2);
    const channels = snapshots.map((s) => s.channel).sort();
    expect(channels).toEqual(["sms", "telegram"]);
  });

  test("cached remote checks preserve original checkedAt (TTL not reset on reuse)", async () => {
    const probe = makeProbe(
      "sms",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: true, message: "remote ok" }],
    );
    service.registerProbe(probe);

    // First call populates cache with freshly fetched remote checks
    const [first] = await service.getReadiness("sms", true);
    const originalCheckedAt = first.checkedAt;
    expect(probe.remoteCallCount).toBe(1);

    // Second call within TTL reuses cache — checkedAt must stay at the original value
    const [second] = await service.getReadiness("sms", true);
    expect(probe.remoteCallCount).toBe(1);
    expect(second.checkedAt).toBe(originalCheckedAt);
  });

  test("includeRemote runs remote checks when cache exists without remote data", async () => {
    const probe = makeProbe(
      "sms",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: true, message: "remote ok" }],
    );
    service.registerProbe(probe);

    // First call without includeRemote — cache has no remote data
    await service.getReadiness("sms", false);
    expect(probe.remoteCallCount).toBe(0);

    // Second call with includeRemote — should run remote checks even though
    // the cached snapshot exists (because it has no remoteChecks)
    const [snapshot] = await service.getReadiness("sms", true);
    expect(probe.remoteCallCount).toBe(1);
    expect(snapshot.remoteChecks).toHaveLength(1);
    expect(snapshot.remoteChecks![0].passed).toBe(true);
  });

  test("failed remote check makes channel not ready", async () => {
    const probe = makeProbe(
      "sms",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: false, message: "API unreachable" }],
    );
    service.registerProbe(probe);

    const [snapshot] = await service.getReadiness("sms", true);

    expect(snapshot.ready).toBe(false);
    expect(snapshot.reasons).toEqual([
      { code: "api_check", text: "API unreachable" },
    ]);
  });

  test("fresh cached remote failures do not affect local-only readiness", async () => {
    const probe = makeProbe(
      "sms",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: false, message: "API unreachable" }],
    );
    service.registerProbe(probe);

    // Prime remote cache with a failing check
    await service.getReadiness("sms", true);

    // Immediately call with includeRemote=false (cache is still fresh within TTL).
    // The cached remote failure should be surfaced for visibility but must NOT
    // affect readiness when the caller explicitly opted out of remote checks.
    const [snapshot] = await service.getReadiness("sms", false);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.reasons).toEqual([]);
    // Remote checks are still visible for informational purposes
    expect(snapshot.remoteChecks).toHaveLength(1);
    expect(snapshot.remoteChecks![0].passed).toBe(false);
  });

  test("stale cached remote failures do not affect local-only readiness", async () => {
    const probe = makeProbe(
      "sms",
      [{ name: "creds", passed: true, message: "ok" }],
      [{ name: "api_check", passed: false, message: "API unreachable" }],
    );
    service.registerProbe(probe);

    // Prime remote cache with a failing check
    await service.getReadiness("sms", true);

    // Age snapshot beyond TTL so remote checks are stale
    const cached = (
      service as unknown as {
        snapshots: Map<string, { checkedAt: number }>;
      }
    ).snapshots.get("sms::__default__")!;
    cached.checkedAt = Date.now() - REMOTE_TTL_MS - 1;

    // Local-only call should not be blocked by stale remote failure
    const [snapshot] = await service.getReadiness("sms", false);
    expect(snapshot.stale).toBe(true);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.reasons).toEqual([]);
  });

  test("remote cache uses fixed internal scope (no per-assistantId scoping)", async () => {
    const probe = makeProbe(
      "sms",
      [{ name: "local", passed: true, message: "ok" }],
      [{ name: "remote", passed: true, message: "ok" }],
    );
    service.registerProbe(probe);

    // All calls share the same cache key since there is no assistantId dimension
    await service.getReadiness("sms", true);
    await service.getReadiness("sms", true);

    expect(probe.remoteCallCount).toBe(1);
  });

  test("voice readiness includes gateway_health when ingress is configured", async () => {
    mockHasTwilioCredentials = true;
    mockTwilioPhoneNumberEnv = "+15550001111";
    mockRawConfig = {
      ingress: {
        enabled: true,
        publicBaseUrl: "https://voice.example.com",
      },
    };
    mockGatewayHealth = {
      target: "http://127.0.0.1:7830",
      healthy: false,
      localDeployment: true,
      error: "connect ECONNREFUSED 127.0.0.1:7830",
    };

    const probeLocalGatewayHealthSpy = spyOn(
      localGatewayHealth,
      "probeLocalGatewayHealth",
    ).mockImplementation(async () => ({
      ...mockGatewayHealth,
    }));

    let snapshot: Awaited<
      ReturnType<ChannelReadinessService["getReadiness"]>
    >[number];
    try {
      const readinessService = createReadinessService();
      [snapshot] = await readinessService.getReadiness("voice");
    } finally {
      probeLocalGatewayHealthSpy.mockRestore();
    }

    const gatewayHealthCheck = snapshot.localChecks.find(
      (check) => check.name === "gateway_health",
    );
    expect(gatewayHealthCheck).toBeDefined();
    expect(gatewayHealthCheck?.passed).toBe(false);
    expect(snapshot.reasons).toContainEqual({
      code: "gateway_health",
      text: "Local gateway is not serving requests at http://127.0.0.1:7830: connect ECONNREFUSED 127.0.0.1:7830",
    });
    expect(snapshot.ready).toBe(false);
  });
});
