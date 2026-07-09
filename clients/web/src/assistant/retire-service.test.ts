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
let storeAssistants: Array<{ id: string }> = [];
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
const syncPlatformAssistantsToLockfileMock = mock(
  async (_a: unknown, _orgId?: string) => {},
);
mock.module("@/lib/local-mode", () => ({
  getLockfile: () => ({ assistants: lockfileAssistants, activeAssistant: null }),
  isLocalAssistant: (a: { cloud?: string }) => a.cloud === "local",
  isLocalMode: () => isLocalModeValue,
  retireLocalAssistant: retireLocalAssistantMock,
  syncPlatformAssistantsToLockfile: syncPlatformAssistantsToLockfileMock,
}));
mock.module("@/stores/organization-store", () => ({
  useOrganizationStore: {
    getState: () => ({ currentOrganizationId: "org-test" }),
  },
}));
mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => ({ user: { id: "user-1" } }),
  },
}));

const clearResearchSnapshotMock = mock((_userId: string | null) => {});
mock.module("@/domains/onboarding/research-onboarding-persistence", () => ({
  clearResearchSnapshot: clearResearchSnapshotMock,
}));

mock.module("@/lib/navigation/navigation-resolver", () => ({
  resolveNavigation: (
    state: Record<string, unknown>,
    query: { kind: string },
  ) => {
    if (query.kind !== "post-retire") return { action: "allow" };
    if (state.hasAssistants) return { action: "redirect", to: state.isLocalMode ? "/assistant/select-assistant" : "/assistant" };
    if (!state.isLocalMode) return { action: "redirect", to: "/assistant/onboarding/privacy" };
    if (state.platformSession === "present") return { action: "redirect", to: "/assistant/onboarding/hosting" };
    return { action: "redirect", to: "/assistant/welcome" };
  },
}));
mock.module("@/lib/navigation/build-state", () => ({
  buildNavigationState: () => ({
    isLocalMode: isLocalModeValue,
    isAuthenticated: false,
    platformSession: "absent",
    hasAssistants: storeAssistants.length > 0,
  }),
}));

const removeMock = mock((assistantId: string) => {
  storeAssistants = storeAssistants.filter((a) => a.id !== assistantId);
});
mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({ remove: removeMock }),
  },
}));

mock.module("@/utils/routes", () => ({
  routes: {
    assistant: "/assistant",
    welcome: "/assistant/welcome",
    selectAssistant: "/assistant/select-assistant",
    onboarding: {
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
  storeAssistants = [];
  retireByIdResult = { ok: true };
  retireLocalResult = { ok: true };
  retireAssistantByIdMock.mockClear();
  listAssistantsMock.mockClear();
  retireLocalAssistantMock.mockClear();
  syncPlatformAssistantsToLockfileMock.mockClear();
  removeMock.mockClear();
  clearResearchSnapshotMock.mockClear();
});

afterEach(() => {
  // keep mock state isolated between tests
});

describe("retireAssistant", () => {
  test("platform assistant routes through the platform delete by id", async () => {
    // GIVEN a platform-hosted target in web mode
    lockfileAssistants = [{ assistantId: "p1", cloud: "vellum" }];
    storeAssistants = [{ id: "p1" }];

    // WHEN retiring it
    const outcome = await retireAssistant("p1");

    // THEN the platform delete ran with that id and the local path did not
    expect(retireAssistantByIdMock).toHaveBeenCalledWith("p1");
    expect(retireLocalAssistantMock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.nextRoute).toBe("/assistant/onboarding/privacy");
    }
  });

  test("a successful retire drops the research-onboarding resume snapshot", async () => {
    // GIVEN a platform-hosted target
    lockfileAssistants = [{ assistantId: "p1", cloud: "vellum" }];
    storeAssistants = [{ id: "p1" }];

    // WHEN retiring it
    const outcome = await retireAssistant("p1");

    // THEN the saved onboarding journey is discarded — a later onboarding must
    // start at the form, not resume the retired assistant's run deep in the
    // flow (e.g. straight onto the wake gate).
    expect(outcome.ok).toBe(true);
    expect(clearResearchSnapshotMock).toHaveBeenCalledWith("user-1");
  });

  test("a failed retire keeps the research-onboarding resume snapshot", async () => {
    // GIVEN the platform delete fails terminally
    lockfileAssistants = [{ assistantId: "p1", cloud: "vellum" }];
    storeAssistants = [{ id: "p1" }];
    retireByIdResult = { ok: false, status: 500, error: { detail: "boom" } };

    // WHEN retiring it
    const outcome = await retireAssistant("p1");

    // THEN the journey survives — the assistant still exists.
    expect(outcome.ok).toBe(false);
    expect(clearResearchSnapshotMock).not.toHaveBeenCalled();
  });

  test("local assistant in local mode routes through the local retire", async () => {
    // GIVEN a local target in local mode
    isLocalModeValue = true;
    lockfileAssistants = [{ assistantId: "l1", cloud: "local" }];
    storeAssistants = [{ id: "l1" }];

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
    storeAssistants = [{ id: "p1" }];

    // WHEN retiring the platform target
    const outcome = await retireAssistant("p1");

    // THEN it uses the platform delete (not local) and re-syncs the lockfile
    expect(retireAssistantByIdMock).toHaveBeenCalledWith("p1");
    expect(retireLocalAssistantMock).not.toHaveBeenCalled();
    expect(syncPlatformAssistantsToLockfileMock).toHaveBeenCalledWith(
      [{ id: "p1", is_local: false, created: "" }],
      "org-test",
    );
    expect(outcome.ok).toBe(true);
  });

  test("a 404 from the platform delete is treated as success", async () => {
    lockfileAssistants = [{ assistantId: "p1", cloud: "vellum" }];
    storeAssistants = [{ id: "p1" }];
    retireByIdResult = { ok: false, status: 404, error: {} };

    const outcome = await retireAssistant("p1");

    expect(outcome.ok).toBe(true);
  });

  test("a non-404 platform failure surfaces the error detail", async () => {
    lockfileAssistants = [{ assistantId: "p1", cloud: "vellum" }];
    storeAssistants = [{ id: "p1" }];
    retireByIdResult = { ok: false, status: 500, error: { detail: "boom" } };

    const outcome = await retireAssistant("p1");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("boom");
    }
  });

  test("post-retire redirects to select-assistant when other assistants remain", async () => {
    isLocalModeValue = true;
    lockfileAssistants = [
      { assistantId: "l1", cloud: "local" },
      { assistantId: "p1", cloud: "vellum" },
    ];
    storeAssistants = [{ id: "l1" }, { id: "p1" }];

    const outcome = await retireAssistant("l1");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.nextRoute).toBe("/assistant/select-assistant");
    }
  });

  test("post-retire redirects to welcome when no assistants and not logged in", async () => {
    isLocalModeValue = true;
    lockfileAssistants = [{ assistantId: "l1", cloud: "local" }];
    storeAssistants = [{ id: "l1" }];

    const outcome = await retireAssistant("l1");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.nextRoute).toBe("/assistant/welcome");
    }
  });
});
