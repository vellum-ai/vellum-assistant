/**
 * Tests for `preactivateHostProxySkills` and `shouldAttachHostProxyForCapability`
 * in `host-proxy-preactivation.ts`.
 *
 * Covers:
 *  - Source interface natively supports capability → preactivate (regression)
 *  - Source interface doesn't support but capable client connected → preactivate
 *  - Source interface doesn't support and no capable client → don't preactivate
 *  - chrome-extension source + capable client connected → don't preactivate (security boundary)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock the event hub — controls which clients are "connected".
// Declared before mocks so the lambda captures it by reference.
// ---------------------------------------------------------------------------

let mockClientsByCapability: Map<string, unknown[]> = new Map();

mock.module("../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    listClientsByCapability: (cap: string) =>
      mockClientsByCapability.get(cap) ?? [],
  },
  broadcastMessage: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks are registered)
// ---------------------------------------------------------------------------

import type { HostProxyCapability } from "../channels/types.js";
import {
  type HostProxyPreactivationTarget,
  preactivateHostProxySkills,
  shouldAttachHostProxyForCapability,
} from "../daemon/host-proxy-preactivation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(): HostProxyPreactivationTarget & {
  preactivatedSkillIds: string[];
} {
  const preactivatedSkillIds: string[] = [];
  return {
    preactivatedSkillIds,
    addPreactivatedSkillId(id: string) {
      preactivatedSkillIds.push(id);
    },
  };
}

function setCapableClient(
  capability: HostProxyCapability,
  connected: boolean,
): void {
  if (connected) {
    mockClientsByCapability.set(capability, [
      { clientId: "mock-macos-client", capabilities: [capability] },
    ]);
  } else {
    mockClientsByCapability.delete(capability);
  }
}

beforeEach(() => {
  mockClientsByCapability = new Map();
});

// ---------------------------------------------------------------------------
// shouldAttachHostProxyForCapability
// ---------------------------------------------------------------------------

describe("shouldAttachHostProxyForCapability", () => {
  describe("host_cu", () => {
    test("returns true when source interface natively supports host_cu (macos)", () => {
      expect(shouldAttachHostProxyForCapability("host_cu", "macos")).toBe(true);
    });

    test("returns false when sourceInterface is undefined", () => {
      expect(shouldAttachHostProxyForCapability("host_cu", undefined)).toBe(
        false,
      );
    });

    test("returns true for web source when a capable client is connected", () => {
      setCapableClient("host_cu", true);
      expect(shouldAttachHostProxyForCapability("host_cu", "web")).toBe(true);
    });

    test("returns false for web source when no capable client is connected", () => {
      setCapableClient("host_cu", false);
      expect(shouldAttachHostProxyForCapability("host_cu", "web")).toBe(false);
    });

    test("returns false for ios source when no capable client is connected", () => {
      setCapableClient("host_cu", false);
      expect(shouldAttachHostProxyForCapability("host_cu", "ios")).toBe(false);
    });

    test("returns true for ios source when a capable client is connected", () => {
      setCapableClient("host_cu", true);
      expect(shouldAttachHostProxyForCapability("host_cu", "ios")).toBe(true);
    });

    test("returns false for chrome-extension source even when a capable client is connected", () => {
      setCapableClient("host_cu", true);
      expect(
        shouldAttachHostProxyForCapability("host_cu", "chrome-extension"),
      ).toBe(false);
    });
  });

  describe("host_app_control", () => {
    test("returns true when source interface natively supports host_app_control (macos)", () => {
      expect(
        shouldAttachHostProxyForCapability("host_app_control", "macos"),
      ).toBe(true);
    });

    test("returns true for web source when a capable client is connected", () => {
      setCapableClient("host_app_control", true);
      expect(
        shouldAttachHostProxyForCapability("host_app_control", "web"),
      ).toBe(true);
    });

    test("returns false for web source when no capable client is connected", () => {
      setCapableClient("host_app_control", false);
      expect(
        shouldAttachHostProxyForCapability("host_app_control", "web"),
      ).toBe(false);
    });

    test("returns false for chrome-extension source even when a capable client is connected", () => {
      setCapableClient("host_app_control", true);
      expect(
        shouldAttachHostProxyForCapability("host_app_control", "chrome-extension"),
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// preactivateHostProxySkills
// ---------------------------------------------------------------------------

describe("preactivateHostProxySkills", () => {
  test("no-ops when sourceInterface is undefined", () => {
    const target = makeTarget();
    preactivateHostProxySkills(target, undefined);
    expect(target.preactivatedSkillIds).toEqual([]);
  });

  test("preactivates computer-use and app-control when source is macos (native support)", () => {
    const target = makeTarget();
    preactivateHostProxySkills(target, "macos");
    expect(target.preactivatedSkillIds).toContain("computer-use");
    expect(target.preactivatedSkillIds).toContain("app-control");
  });

  test("preactivates skills for web source when capable clients are connected (cross-client)", () => {
    setCapableClient("host_cu", true);
    setCapableClient("host_app_control", true);
    const target = makeTarget();
    preactivateHostProxySkills(target, "web");
    expect(target.preactivatedSkillIds).toContain("computer-use");
    expect(target.preactivatedSkillIds).toContain("app-control");
  });

  test("preactivates only the skill whose capable client is connected", () => {
    setCapableClient("host_cu", true);
    setCapableClient("host_app_control", false);
    const target = makeTarget();
    preactivateHostProxySkills(target, "web");
    expect(target.preactivatedSkillIds).toContain("computer-use");
    expect(target.preactivatedSkillIds).not.toContain("app-control");
  });

  test("preactivates nothing for web source when no capable clients are connected", () => {
    setCapableClient("host_cu", false);
    setCapableClient("host_app_control", false);
    const target = makeTarget();
    preactivateHostProxySkills(target, "web");
    expect(target.preactivatedSkillIds).toEqual([]);
  });

  test("preactivates nothing for ios source when no capable clients are connected", () => {
    setCapableClient("host_cu", false);
    setCapableClient("host_app_control", false);
    const target = makeTarget();
    preactivateHostProxySkills(target, "ios");
    expect(target.preactivatedSkillIds).toEqual([]);
  });

  test("does not preactivate for chrome-extension source even when capable clients are connected", () => {
    setCapableClient("host_cu", true);
    setCapableClient("host_app_control", true);
    const target = makeTarget();
    preactivateHostProxySkills(target, "chrome-extension");
    expect(target.preactivatedSkillIds).toEqual([]);
  });
});
