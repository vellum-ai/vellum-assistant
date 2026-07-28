import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  HealthzProbeResult,
  LocalAssistantHealth,
} from "@/assistant/local-health";
import type { AssistantState } from "@/assistant/types";

let deriveLocalAssistantHealth: (
  result: HealthzProbeResult,
) => LocalAssistantHealth;
let useLocalAssistantHealth: () => LocalAssistantHealth | null;

let assistantStateMock: AssistantState = { kind: "loading" };

mock.module("@/assistant/lifecycle-store", () => ({
  useAssistantLifecycleStore: {
    use: {
      assistantState: () => assistantStateMock,
    },
  },
}));

beforeAll(async () => {
  ({ deriveLocalAssistantHealth, useLocalAssistantHealth } =
    await import("@/assistant/local-health"));
});

beforeEach(() => {
  assistantStateMock = { kind: "loading" };
});

describe("deriveLocalAssistantHealth", () => {
  test("returns unreachable for a non-2xx response", () => {
    expect(deriveLocalAssistantHealth({ ok: false })).toBe("unreachable");
  });

  test("returns healthy for a healthy status", () => {
    expect(
      deriveLocalAssistantHealth({ ok: true, data: { status: "healthy" } }),
    ).toBe("healthy");
  });

  test("returns healthy for an ok status", () => {
    expect(
      deriveLocalAssistantHealth({ ok: true, data: { status: "ok" } }),
    ).toBe("healthy");
  });

  test("treats a 2xx response without a status field as healthy", () => {
    expect(deriveLocalAssistantHealth({ ok: true, data: {} })).toBe("healthy");
  });

  test("returns unhealthy for any other reported status", () => {
    expect(
      deriveLocalAssistantHealth({ ok: true, data: { status: "degraded" } }),
    ).toBe("unhealthy");
  });

  test("returns migrating while the daemon reports MIGRATING", () => {
    // The daemon's detailed health reports MIGRATING while its startup DB
    // migrations run — an expected in-progress phase, not an unhealthy state
    // that should invite a mid-migration restart.
    expect(
      deriveLocalAssistantHealth({ ok: true, data: { status: "MIGRATING" } }),
    ).toBe("migrating");
  });

  test("returns unhealthy when the daemon reports ERROR (failed migrations)", () => {
    expect(
      deriveLocalAssistantHealth({ ok: true, data: { status: "ERROR" } }),
    ).toBe("unhealthy");
  });
});

describe("useLocalAssistantHealth", () => {
  test("returns null while the lifecycle is unresolved", () => {
    expect(useLocalAssistantHealth()).toBeNull();
  });

  test("returns null for platform-hosted assistants even with health set", () => {
    assistantStateMock = { kind: "active", isLocal: false, health: "healthy" };
    expect(useLocalAssistantHealth()).toBeNull();
  });

  test("returns null for a local assistant before the first probe", () => {
    assistantStateMock = { kind: "active", isLocal: true };
    expect(useLocalAssistantHealth()).toBeNull();
  });

  test("returns the heartbeat health for a local active assistant", () => {
    assistantStateMock = {
      kind: "active",
      isLocal: true,
      health: "unreachable",
    };
    expect(useLocalAssistantHealth()).toBe("unreachable");
  });

  test("returns the heartbeat health for a self-hosted assistant", () => {
    assistantStateMock = { kind: "self_hosted", health: "unhealthy" };
    expect(useLocalAssistantHealth()).toBe("unhealthy");
  });
});
