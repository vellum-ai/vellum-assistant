/**
 * Unit tests for the retire service. The point of extracting it from the
 * settings component was so a retire can run for an arbitrary assistant id
 * (e.g. the tray "Retire <assistant>…" command) and route local-vs-platform by
 * the *target* assistant rather than the currently selected one. These tests
 * pin that routing plus the failure/404/cleanup behavior.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// --- mutable mock state (set per test) --- //

let isLocalModeValue = false;
let lockfileAssistants: Array<{ assistantId: string; cloud?: string }> = [];
let retireByIdResult: { ok: true } | { ok: false; status: number; error: Record<string, unknown> } = { ok: true };
let retireLocalResult: { ok: true } | { ok: false; error?: string } = { ok: true };

// --- module mocks --- //

const retireAssistantByIdMock = mock(async (_id: string) => retireByIdResult);
const listAssistantsMock = mock(async () => ({ ok: true as const, status: 200, data: [{ id: "p1", is_local: false, created: "" }] }));
mock.module("@/assistant/api", () => ({
  retireAssistantById: retireAssistantByIdMock,
  listAssistants: listAssistantsMock,
}));

const retireLocalAssistantMock = mock(async (_id: string) => retireLocalResult);
const syncPlatformAssistantsToLockfileMock = mock(async (_a: unknown) => {});
mock.module("@/lib/local-mode", () => ({
  getLockfile: () => ({ assistants: lockfileAssistants, activeAssistant: null }),
  isLocalAssistant: (a: { cloud?: string }) => a.cloud !== "vellum",
  isLocalMode: () => isLocalModeValue,
  retireLocalAssistant: retireLocalAssistantMock,
  syncPlatformAssistantsToLockfile: syncPlatformAssistantsToLockfileMock,
}));

mock.module("@/lib/navigation/navigation-resolver", () => ({
  resolveNavigation: (
    state: Record<string, unknown>,
    query: { kind: string },
  ) => {
    if (query.kind !== "post-retire") return { action: "allow" };
    if (state.hasAssistants) return { action: "redirect", to: state.isLocalMode ? "/assistant/onboarding/select-assistant" : "/assistant" };
    if (!state.isLocalMode) return { action: "redirect", to: "/assistant/onboarding/privacy" };
    if (state.platformSession === "present") return { action: "redirect", to: "/assistant/onboarding/hosting" };
    return { action: "redirect", to: "/assistant/onboarding/welcome" };
  },
}));
mock.module("@/lib/navigation/build-state", () => ({
  buildNavigationState: (overrides?: Record<string, unknown>) => ({
    isLocalMode: isLocalModeValue,
    isAuthenticated: false,
    platformSession: "absent",
    ...overrides,
  }),
}));

const clearOnboardingFlagsMock = mock(() => {});
mock.module("@/utils/onboarding-cleanup", () => ({
  clearOnboardingFlags: clearOnboardingFlagsMock,
}));

mock.module("@/utils/routes", () => ({
  routes: {
    assistant: "/assistant",
    onboarding: {
      welcome: "/assistant/onboarding/welcome",
      selectAssistant: "/assistant/onboarding/select-assistant",
      hosting: "/assistant/onboarding/hosting",
      prechat: "/assistant/onboarding/prechat",
      privacy: "/assistant/onboarding/privacy",
    },
  },
}));

const { retireAssistant } = await import("./retire-service");

beforeEach(() => {
  isLocalModeValue = false;
  lockfileAssistants = [];
  retireByIdResult = { ok: true };
  retireLocalResult = { ok: true };
  retireAssistantByIdMock.mockClear();
  listAssistantsMock.mockClear();
  retireLocalAssistantMock.mockClear();
  syncPlatformAssistantsToLockfileMock.mockClear();
  clearOnboardingFlagsMock.mockClear();
});

afterEach(() => {
  // keep mock state isolated between tests
});

describe("retireAssistant", () => {
  test("platform assistant routes through the platform delete by id", async () => {
    // GIVEN a platform-hosted target in web mode
    lockfileAssistants = [{ assistantId: "p1", cloud: "vellum" }];

    // WHEN retiring it
    const outcome = await retireAssistant("p1");

    // THEN the platform delete ran with that id and the local path did not
    expect(retireAssistantByIdMock).toHaveBeenCalledWith("p1");
    expect(retireLocalAssistantMock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.nextRoute).toBe("/assistant/onboarding/privacy");
    }
    expect(clearOnboardingFlagsMock).toHaveBeenCalled();
  });

  test("local assistant in local mode routes through the local retire", async () => {
    // GIVEN a local target in local mode
    isLocalModeValue = true;
    lockfileAssistants = [{ assistantId: "l1", cloud: "local" }];

    // WHEN retiring it
    const outcome = await retireAssistant("l1");

    // THEN the local retire ran and the platform path did not
    expect(retireLocalAssistantMock).toHaveBeenCalledWith("l1");
    expect(retireAssistantByIdMock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
  });

  test("routes by the TARGET assistant, not local-mode alone", async () => {
    // GIVEN local mode but the *target* is a platform assistant
    isLocalModeValue = true;
    lockfileAssistants = [{ assistantId: "p1", cloud: "vellum" }];

    // WHEN retiring the platform target
    const outcome = await retireAssistant("p1");

    // THEN it uses the platform delete (not local) and re-syncs the lockfile
    expect(retireAssistantByIdMock).toHaveBeenCalledWith("p1");
    expect(retireLocalAssistantMock).not.toHaveBeenCalled();
    expect(syncPlatformAssistantsToLockfileMock).toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
  });

  test("a 404 from the platform delete is treated as success", async () => {
    lockfileAssistants = [{ assistantId: "p1", cloud: "vellum" }];
    retireByIdResult = { ok: false, status: 404, error: {} };

    const outcome = await retireAssistant("p1");

    expect(outcome.ok).toBe(true);
    expect(clearOnboardingFlagsMock).toHaveBeenCalled();
  });

  test("a non-404 platform failure surfaces the error detail", async () => {
    lockfileAssistants = [{ assistantId: "p1", cloud: "vellum" }];
    retireByIdResult = { ok: false, status: 500, error: { detail: "boom" } };

    const outcome = await retireAssistant("p1");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("boom");
    }
    expect(clearOnboardingFlagsMock).not.toHaveBeenCalled();
  });

  test("post-retire redirects to select-assistant when other assistants remain", async () => {
    isLocalModeValue = true;
    lockfileAssistants = [
      { assistantId: "l1", cloud: "local" },
      { assistantId: "p1", cloud: "vellum" },
    ];

    const outcome = await retireAssistant("l1");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.nextRoute).toBe("/assistant/onboarding/select-assistant");
    }
  });

  test("post-retire redirects to welcome when no assistants and not logged in", async () => {
    isLocalModeValue = true;
    lockfileAssistants = [{ assistantId: "l1", cloud: "local" }];

    const outcome = await retireAssistant("l1");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.nextRoute).toBe("/assistant/onboarding/welcome");
    }
  });
});
