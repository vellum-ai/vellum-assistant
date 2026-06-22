/**
 * Tests for `evaluateHostProxyAttachment`, `preactivateHostProxySkills`, and
 * `shouldAttachHostProxyForCapability` in `host-proxy-preactivation.ts`.
 *
 * Covers:
 *  - Source interface natively supports capability → preactivate (regression)
 *  - Source interface doesn't support but capable client connected → preactivate
 *  - Source interface doesn't support and no capable client → don't preactivate
 *  - chrome-extension source + capable client connected → don't preactivate (security boundary)
 *  - `evaluateHostProxyAttachment` returns the correct `reason` for each branch
 *  - `preactivateHostProxySkills` emits one structured log line per call with
 *    conversationId, sourceInterface, per-capability decisions, and final
 *    preactivatedSkillIds (used by ATL-609-class silent-gate diagnosis)
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

// ---------------------------------------------------------------------------
// Mock the logger so we can assert on the structured info call.
// `info` calls are pushed into `loggedInfoCalls` for inspection.
// `child()` is exposed for callers that wrap the logger that way.
// ---------------------------------------------------------------------------

interface LoggedCall {
  fields: Record<string, unknown>;
  message: string;
}
const loggedInfoCalls: LoggedCall[] = [];
function captureInfo(fields: unknown, message: unknown) {
  loggedInfoCalls.push({
    fields: fields as Record<string, unknown>,
    message: message as string,
  });
}

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: captureInfo,
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: captureInfo,
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    }),
  }),
}));

// ---------------------------------------------------------------------------
// Imports under test
//
// Type-only imports are erased at runtime and safe to hoist. The value import
// of `host-proxy-preactivation` must be dynamic (`await import`) so it
// resolves AFTER the `mock.module(...)` calls above — otherwise ES module
// hoisting loads the real logger before the mock registers, the production
// `const log = getLogger(...)` binds to real pino, and assertions against
// `loggedInfoCalls` see an empty array. Same pattern as
// `secret-prompt-log-hygiene.test.ts`.
// ---------------------------------------------------------------------------

import type { HostProxyCapability } from "../channels/types.js";
import type { HostProxyPreactivationTarget } from "../daemon/host-proxy-preactivation.js";

const {
  evaluateHostProxyAttachment,
  preactivateHostProxySkills,
  shouldAttachHostProxyForCapability,
} = await import("../daemon/host-proxy-preactivation.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(
  conversationId = "conv-test",
): HostProxyPreactivationTarget & { preactivatedSkillIds: string[] } {
  const preactivatedSkillIds: string[] = [];
  return {
    conversationId,
    preactivatedSkillIds,
    addPreactivatedSkillId(id: string) {
      preactivatedSkillIds.push(id);
    },
  };
}

function setCapableClient(
  capability: HostProxyCapability,
  connected: boolean,
  actorPrincipalId = "user-1",
): void {
  if (connected) {
    mockClientsByCapability.set(capability, [
      {
        clientId: "mock-macos-client",
        capabilities: [capability],
        actorPrincipalId,
      },
    ]);
  } else {
    mockClientsByCapability.delete(capability);
  }
}

beforeEach(() => {
  mockClientsByCapability = new Map();
  loggedInfoCalls.length = 0;
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
      expect(
        shouldAttachHostProxyForCapability("host_cu", "web", "user-1"),
      ).toBe(true);
    });

    test("returns false for web source when no capable client is connected", () => {
      setCapableClient("host_cu", false);
      expect(
        shouldAttachHostProxyForCapability("host_cu", "web", "user-1"),
      ).toBe(false);
    });

    test("returns false for ios source when no capable client is connected", () => {
      setCapableClient("host_cu", false);
      expect(
        shouldAttachHostProxyForCapability("host_cu", "ios", "user-1"),
      ).toBe(false);
    });

    test("returns true for ios source when a capable client is connected", () => {
      setCapableClient("host_cu", true);
      expect(
        shouldAttachHostProxyForCapability("host_cu", "ios", "user-1"),
      ).toBe(true);
    });

    test("returns false for web source when only a different actor is capable", () => {
      setCapableClient("host_cu", true, "user-other");
      expect(
        shouldAttachHostProxyForCapability("host_cu", "web", "user-1"),
      ).toBe(false);
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
        shouldAttachHostProxyForCapability("host_app_control", "web", "user-1"),
      ).toBe(true);
    });

    test("returns false for web source when no capable client is connected", () => {
      setCapableClient("host_app_control", false);
      expect(
        shouldAttachHostProxyForCapability("host_app_control", "web", "user-1"),
      ).toBe(false);
    });

    test("returns false for web source when only a different actor is capable", () => {
      setCapableClient("host_app_control", true, "user-other");
      expect(
        shouldAttachHostProxyForCapability(
          "host_app_control",
          "web",
          "user-1",
        ),
      ).toBe(false);
    });

    test("returns false for chrome-extension source even when a capable client is connected", () => {
      setCapableClient("host_app_control", true);
      expect(
        shouldAttachHostProxyForCapability(
          "host_app_control",
          "chrome-extension",
        ),
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// preactivateHostProxySkills
// ---------------------------------------------------------------------------

describe("preactivateHostProxySkills", () => {
  test("preactivates no skills when sourceInterface is undefined", () => {
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
    preactivateHostProxySkills(target, "web", "user-1");
    expect(target.preactivatedSkillIds).toContain("computer-use");
    expect(target.preactivatedSkillIds).toContain("app-control");
  });

  test("preactivates only the skill whose capable client is connected", () => {
    setCapableClient("host_cu", true);
    setCapableClient("host_app_control", false);
    const target = makeTarget();
    preactivateHostProxySkills(target, "web", "user-1");
    expect(target.preactivatedSkillIds).toContain("computer-use");
    expect(target.preactivatedSkillIds).not.toContain("app-control");
  });

  test("preactivates nothing for web source when no capable clients are connected", () => {
    setCapableClient("host_cu", false);
    setCapableClient("host_app_control", false);
    const target = makeTarget();
    preactivateHostProxySkills(target, "web", "user-1");
    expect(target.preactivatedSkillIds).toEqual([]);
  });

  test("preactivates nothing for ios source when no capable clients are connected", () => {
    setCapableClient("host_cu", false);
    setCapableClient("host_app_control", false);
    const target = makeTarget();
    preactivateHostProxySkills(target, "ios", "user-1");
    expect(target.preactivatedSkillIds).toEqual([]);
  });

  test("does not preactivate for web source when only different-actor clients are connected", () => {
    setCapableClient("host_cu", true, "user-other");
    setCapableClient("host_app_control", true, "user-other");
    const target = makeTarget();
    preactivateHostProxySkills(target, "web", "user-1");
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

// ---------------------------------------------------------------------------
// evaluateHostProxyAttachment — reason coverage
// ---------------------------------------------------------------------------

describe("evaluateHostProxyAttachment", () => {
  test("returns denied_no_interface when sourceInterface is undefined", () => {
    expect(evaluateHostProxyAttachment("host_cu", undefined)).toEqual({
      shouldAttach: false,
      reason: "denied_no_interface",
    });
  });

  test("returns native_support for macos + host_cu", () => {
    expect(evaluateHostProxyAttachment("host_cu", "macos")).toEqual({
      shouldAttach: true,
      reason: "native_support",
    });
  });

  test("returns denied_chrome_extension for chrome-extension source even when capable clients exist", () => {
    setCapableClient("host_cu", true);
    expect(evaluateHostProxyAttachment("host_cu", "chrome-extension")).toEqual({
      shouldAttach: false,
      reason: "denied_chrome_extension",
    });
  });

  test("returns cross_client with clientCount when a capable client is connected", () => {
    setCapableClient("host_cu", true);
    expect(evaluateHostProxyAttachment("host_cu", "web", "user-1")).toEqual({
      shouldAttach: true,
      reason: "cross_client",
      clientCount: 1,
    });
  });

  test("returns denied_no_clients with clientCount 0 when no capable client is connected", () => {
    setCapableClient("host_cu", false);
    expect(evaluateHostProxyAttachment("host_cu", "web", "user-1")).toEqual({
      shouldAttach: false,
      reason: "denied_no_clients",
      clientCount: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// preactivateHostProxySkills — structured logging
// ---------------------------------------------------------------------------

describe("preactivateHostProxySkills logging", () => {
  test("emits exactly one info log per call", () => {
    const target = makeTarget();
    preactivateHostProxySkills(target, "macos");
    expect(loggedInfoCalls).toHaveLength(1);
    expect(loggedInfoCalls[0].message).toBe(
      "host-proxy preactivation decision",
    );
  });

  test("log includes conversationId, sourceInterface, per-capability decisions, and preactivatedSkillIds for macos", () => {
    const target = makeTarget("conv-macos-123");
    preactivateHostProxySkills(target, "macos");

    expect(loggedInfoCalls).toHaveLength(1);
    const { fields } = loggedInfoCalls[0];
    expect(fields.conversationId).toBe("conv-macos-123");
    expect(fields.sourceInterface).toBe("macos");
    expect(fields.decisions).toEqual({
      host_cu: { shouldAttach: true, reason: "native_support" },
      host_app_control: { shouldAttach: true, reason: "native_support" },
    });
    expect(fields.preactivatedSkillIds).toEqual([
      "computer-use",
      "app-control",
    ]);
  });

  test("log captures denied_no_interface for undefined sourceInterface (silent-gate diagnostic)", () => {
    const target = makeTarget("conv-no-interface");
    preactivateHostProxySkills(target, undefined);

    expect(loggedInfoCalls).toHaveLength(1);
    const { fields } = loggedInfoCalls[0];
    expect(fields.conversationId).toBe("conv-no-interface");
    expect(fields.sourceInterface).toBeUndefined();
    expect(fields.decisions).toEqual({
      host_cu: { shouldAttach: false, reason: "denied_no_interface" },
      host_app_control: { shouldAttach: false, reason: "denied_no_interface" },
    });
    expect(fields.preactivatedSkillIds).toEqual([]);
  });

  test("log captures cross_client + clientCount when a web source has a connected host_cu client", () => {
    setCapableClient("host_cu", true);
    const target = makeTarget();
    preactivateHostProxySkills(target, "web", "user-1");

    expect(loggedInfoCalls).toHaveLength(1);
    const decisions = loggedInfoCalls[0].fields.decisions as Record<
      string,
      unknown
    >;
    expect(decisions.host_cu).toEqual({
      shouldAttach: true,
      reason: "cross_client",
      clientCount: 1,
    });
    expect(decisions.host_app_control).toEqual({
      shouldAttach: false,
      reason: "denied_no_clients",
      clientCount: 0,
    });
    expect(loggedInfoCalls[0].fields.preactivatedSkillIds).toEqual([
      "computer-use",
    ]);
  });

  test("log captures denied_chrome_extension reason for chrome-extension source", () => {
    setCapableClient("host_cu", true);
    const target = makeTarget();
    preactivateHostProxySkills(target, "chrome-extension");

    expect(loggedInfoCalls).toHaveLength(1);
    const decisions = loggedInfoCalls[0].fields.decisions as Record<
      string,
      unknown
    >;
    expect(decisions.host_cu).toEqual({
      shouldAttach: false,
      reason: "denied_chrome_extension",
    });
    expect(loggedInfoCalls[0].fields.preactivatedSkillIds).toEqual([]);
  });
});
