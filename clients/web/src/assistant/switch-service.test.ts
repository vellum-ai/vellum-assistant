/**
 * Unit tests for the host-command switch/remove service. Pins the two
 * behaviors the tray commands rely on: a paired entry connects through
 * `connectPairedAssistant` (never the bare selection write), and a paired
 * removal clears the lifecycle's active id and routes to the chooser when
 * the removed entry was the effective selection.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

// --- mutable mock state (set per test) --- //

let lockfileAssistants: Array<{ assistantId: string; cloud?: string }> = [];
// Entries the next loadLockfile makes visible, standing in for a lockfile
// change (e.g. `vellum connect import`) the renderer cache hasn't seen.
let lockfileAssistantsAfterReload: Array<{
  assistantId: string;
  cloud?: string;
}> | null = null;
let selectedAssistant: { assistantId: string } | undefined = undefined;
let removeFromLockfileResult: { ok: boolean; error?: string } = { ok: true };
let connectPairedShouldThrow = false;
let activeAssistantId: string | null = null;
let localClient = false;

// --- module mocks --- //

const removePairedFromLockfileMock = mock(
  async (_id: string) => removeFromLockfileResult,
);
const loadLockfileMock = mock(async () => {
  if (lockfileAssistantsAfterReload) {
    lockfileAssistants = lockfileAssistantsAfterReload;
    lockfileAssistantsAfterReload = null;
  }
  return { assistants: lockfileAssistants, activeAssistant: null };
});
mock.module("@/lib/local-mode", () => ({
  getLockfileAssistant: (id: string) =>
    lockfileAssistants.find((a) => a.assistantId === id),
  getSelectedAssistant: () => selectedAssistant,
  isLocalClient: () => localClient,
  isPairedAssistant: (a: { cloud?: string }) => a.cloud === "paired",
  loadLockfile: loadLockfileMock,
  removePairedAssistantFromLockfile: removePairedFromLockfileMock,
}));

const forgetAssistantAvatarMock = mock((_qc: QueryClient, _id: string) => {});
mock.module("@/hooks/use-chooser-row-avatar", () => ({
  forgetAssistantAvatar: forgetAssistantAvatarMock,
}));
const queryClient = new QueryClient();

const connectPairedAssistantMock = mock(async (_id: string) => {
  if (connectPairedShouldThrow) {
    throw new Error("guardian lease failed");
  }
});
const connectLocalAssistantMock = mock(async (_id: string) => {});
const connectPlatformAssistantMock = mock(async (_id: string) => {});
mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => ({
      connectPairedAssistant: connectPairedAssistantMock,
      connectLocalAssistant: connectLocalAssistantMock,
      connectPlatformAssistant: connectPlatformAssistantMock,
    }),
  },
}));

const setSelectedAssistantMock = mock(async (_id: string | null) => {});
mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: setSelectedAssistantMock,
}));

const setActiveAssistantIdMock = mock((id: string | null) => {
  activeAssistantId = id;
});
mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({
      activeAssistantId,
      setActiveAssistantId: setActiveAssistantIdMock,
    }),
  },
}));

mock.module("@/utils/routes", () => ({
  routes: {
    selectAssistant: "/assistant/select-assistant",
  },
}));

const { removePairedAssistant, switchToAssistant, switchToResolvedAssistant } =
  await import("./switch-service");

beforeEach(() => {
  lockfileAssistants = [];
  lockfileAssistantsAfterReload = null;
  selectedAssistant = undefined;
  removeFromLockfileResult = { ok: true };
  connectPairedShouldThrow = false;
  activeAssistantId = null;
  localClient = false;
  removePairedFromLockfileMock.mockClear();
  loadLockfileMock.mockClear();
  connectPairedAssistantMock.mockClear();
  connectLocalAssistantMock.mockClear();
  connectPlatformAssistantMock.mockClear();
  setSelectedAssistantMock.mockClear();
  setActiveAssistantIdMock.mockClear();
  forgetAssistantAvatarMock.mockClear();
});

describe("switchToAssistant", () => {
  test("a paired entry connects through connectPairedAssistant, not the selection write", async () => {
    lockfileAssistants = [{ assistantId: "pr1", cloud: "paired" }];

    const outcome = await switchToAssistant("pr1");

    expect(outcome.ok).toBe(true);
    expect(connectPairedAssistantMock).toHaveBeenCalledWith("pr1");
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });

  test("a managed entry goes through the platform selection path", async () => {
    lockfileAssistants = [{ assistantId: "m1", cloud: "vellum" }];

    const outcome = await switchToAssistant("m1");

    expect(outcome.ok).toBe(true);
    expect(setSelectedAssistantMock).toHaveBeenCalledWith("m1");
    expect(connectPairedAssistantMock).not.toHaveBeenCalled();
  });

  test("an id with no lockfile entry reloads the lockfile, then falls back to the selection write", async () => {
    const outcome = await switchToAssistant("ghost");

    expect(outcome.ok).toBe(true);
    expect(loadLockfileMock).toHaveBeenCalledTimes(1);
    expect(setSelectedAssistantMock).toHaveBeenCalledWith("ghost");
  });

  test("a paired entry the cache hasn't loaded yet connects with credentials after the reload", async () => {
    // A `vellum connect import` while the app was open: the tray (fed by
    // main's watched lockfile) knows the entry, the renderer cache doesn't.
    lockfileAssistantsAfterReload = [{ assistantId: "pr2", cloud: "paired" }];

    const outcome = await switchToAssistant("pr2");

    expect(outcome.ok).toBe(true);
    expect(loadLockfileMock).toHaveBeenCalledTimes(1);
    expect(connectPairedAssistantMock).toHaveBeenCalledWith("pr2");
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });

  test("a cached entry never triggers a reload", async () => {
    lockfileAssistants = [{ assistantId: "pr1", cloud: "paired" }];

    await switchToAssistant("pr1");

    expect(loadLockfileMock).not.toHaveBeenCalled();
  });

  test("a failed paired connect surfaces an error outcome", async () => {
    lockfileAssistants = [{ assistantId: "pr1", cloud: "paired" }];
    connectPairedShouldThrow = true;

    const outcome = await switchToAssistant("pr1");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("Failed to connect to the assistant.");
    }
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });
});

describe("switchToResolvedAssistant", () => {
  const resolved = (
    overrides: Partial<
      import("@/stores/resolved-assistants-store").ResolvedAssistant
    > & { id: string },
  ) => ({
    isLocal: false,
    isPlatformHosted: true,
    isPaired: false,
    ...overrides,
  });

  test("a paired entry connects through connectPairedAssistant", async () => {
    await switchToResolvedAssistant(
      resolved({
        id: "pr1",
        isPaired: true,
        isLocal: false,
        isPlatformHosted: false,
      }),
    );

    expect(connectPairedAssistantMock).toHaveBeenCalledWith("pr1");
    expect(connectLocalAssistantMock).not.toHaveBeenCalled();
    expect(connectPlatformAssistantMock).not.toHaveBeenCalled();
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });

  test("a local entry on a local client connects through connectLocalAssistant", async () => {
    localClient = true;

    await switchToResolvedAssistant(
      resolved({ id: "lo1", isLocal: true, isPlatformHosted: false }),
    );

    expect(connectLocalAssistantMock).toHaveBeenCalledWith("lo1");
    expect(connectPlatformAssistantMock).not.toHaveBeenCalled();
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });

  test("a hub-listed local entry takes the platform path", async () => {
    localClient = false;

    await switchToResolvedAssistant(
      resolved({ id: "lo2", isLocal: true, isPlatformHosted: false }),
    );

    expect(connectPlatformAssistantMock).toHaveBeenCalledWith("lo2");
    expect(connectLocalAssistantMock).not.toHaveBeenCalled();
  });

  test("a platform-hosted entry takes the platform path", async () => {
    await switchToResolvedAssistant(resolved({ id: "m1" }));

    expect(connectPlatformAssistantMock).toHaveBeenCalledWith("m1");
    expect(connectPairedAssistantMock).not.toHaveBeenCalled();
  });

  test("a failed connect rethrows for the caller to surface", async () => {
    connectPairedShouldThrow = true;

    await expect(
      switchToResolvedAssistant(
        resolved({
          id: "pr1",
          isPaired: true,
          isLocal: false,
          isPlatformHosted: false,
        }),
      ),
    ).rejects.toThrow("guardian lease failed");
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });
});

describe("removePairedAssistant", () => {
  test("removing the selected pairing clears the active id and routes to the chooser", async () => {
    lockfileAssistants = [{ assistantId: "pr1", cloud: "paired" }];
    selectedAssistant = { assistantId: "pr1" };
    activeAssistantId = "pr1";

    const outcome = await removePairedAssistant(queryClient, "pr1");

    expect(removePairedFromLockfileMock).toHaveBeenCalledWith("pr1");
    expect(forgetAssistantAvatarMock).toHaveBeenCalledWith(queryClient, "pr1");
    expect(setActiveAssistantIdMock).toHaveBeenCalledWith(null);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.nextRoute).toBe(
        "/assistant/select-assistant?noAutoSkip=1",
      );
    }
  });

  test("removing a non-selected pairing stays put and leaves the active id alone", async () => {
    lockfileAssistants = [
      { assistantId: "pr1", cloud: "paired" },
      { assistantId: "m1", cloud: "vellum" },
    ];
    selectedAssistant = { assistantId: "m1" };
    activeAssistantId = "m1";

    const outcome = await removePairedAssistant(queryClient, "pr1");

    expect(setActiveAssistantIdMock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.nextRoute).toBeNull();
    }
  });

  test("a failed host removal surfaces the error and touches nothing", async () => {
    selectedAssistant = { assistantId: "pr1" };
    activeAssistantId = "pr1";
    removeFromLockfileResult = { ok: false, error: "host says no" };

    const outcome = await removePairedAssistant(queryClient, "pr1");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("host says no");
    }
    expect(forgetAssistantAvatarMock).not.toHaveBeenCalled();
    expect(setActiveAssistantIdMock).not.toHaveBeenCalled();
  });

  test("a rejected host removal resolves to an error outcome instead of throwing", async () => {
    selectedAssistant = { assistantId: "pr1" };
    activeAssistantId = "pr1";
    removePairedFromLockfileMock.mockImplementationOnce(async () => {
      throw new Error("ipc channel gone");
    });

    const outcome = await removePairedAssistant(queryClient, "pr1");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("Failed to remove assistant.");
    }
    expect(setActiveAssistantIdMock).not.toHaveBeenCalled();
  });
});
