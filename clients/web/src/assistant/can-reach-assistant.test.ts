import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { LockfileAssistant } from "@/lib/local-mode";
import type { PlatformSessionStatus } from "@/stores/session-status";

// The hosting-mode functions read runtime config (injected globals, env), so
// drive them off plain flags the tests set per-case. `isLocalAssistant` /
// `isPlatformAssistant` keep the real classification logic over the fixture's
// `cloud`/`resources` fields, matching the auth-store test's mock style.
let mockIsLocalMode = false;
let mockIsRemoteGatewayMode = false;

mock.module("@/lib/local-mode", () => ({
  isLocalMode: () => mockIsLocalMode,
  isRemoteGatewayMode: () => mockIsRemoteGatewayMode,
  isLocalAssistant: (a: {
    cloud?: string;
    resources?: { gatewayPort?: number };
  }) => a.cloud !== "vellum" && a.resources?.gatewayPort != null,
  isPlatformAssistant: (a: { cloud?: string }) => a.cloud === "vellum",
}));

const { canReachAssistant } = await import("@/assistant/can-reach-assistant");

const localAssistant: LockfileAssistant = {
  assistantId: "local-a",
  cloud: "local",
  resources: { gatewayPort: 51234, daemonPort: 51235 },
};

const platformAssistant: LockfileAssistant = {
  assistantId: "platform-a",
  cloud: "vellum",
};

function reach(
  a: LockfileAssistant,
  gatewayTokenPresent: boolean,
  platformSession: PlatformSessionStatus = "absent",
): boolean {
  return canReachAssistant(a, { gatewayTokenPresent, platformSession });
}

beforeEach(() => {
  mockIsLocalMode = false;
  mockIsRemoteGatewayMode = false;
});

describe("canReachAssistant", () => {
  describe("local mode + local assistant", () => {
    beforeEach(() => {
      mockIsLocalMode = true;
    });

    test("reachable with a gateway token", () => {
      expect(reach(localAssistant, true)).toBe(true);
    });

    test("unreachable without a gateway token", () => {
      expect(reach(localAssistant, false)).toBe(false);
    });
  });

  describe("remote-gateway mode", () => {
    beforeEach(() => {
      mockIsRemoteGatewayMode = true;
    });

    test("reachable with a gateway token", () => {
      expect(reach(localAssistant, true)).toBe(true);
    });

    test("unreachable without a gateway token", () => {
      expect(reach(localAssistant, false)).toBe(false);
    });
  });

  describe("platform-hosted assistant", () => {
    test("reachable when the platform session is present", () => {
      expect(reach(platformAssistant, false, "present")).toBe(true);
    });

    // A gateway token must never stand in for a platform session: with no live
    // session the assistant is unreachable regardless of the token.
    test.each<PlatformSessionStatus>(["absent", "unknown"])(
      "never reachable for platformSession %s",
      (status) => {
        expect(reach(platformAssistant, true, status)).toBe(false);
        expect(reach(platformAssistant, false, status)).toBe(false);
      },
    );
  });

  // A platform-hosted assistant while the app is in local mode: local mode does
  // not short-circuit it (the local branch only matches local assistants), so
  // it still falls through to the platform-session check.
  describe("platform-hosted assistant in local mode", () => {
    beforeEach(() => {
      mockIsLocalMode = true;
    });

    test("reachable when the platform session is present", () => {
      expect(reach(platformAssistant, false, "present")).toBe(true);
    });

    test("unreachable when the platform session is absent", () => {
      expect(reach(platformAssistant, false, "absent")).toBe(false);
    });
  });
});
