import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { composerConfigurationFixture } from "@/domains/chat/components/composer-configuration.test-utils";

let supported: boolean | undefined = true;
let capabilityError = false;
mock.module("@/hooks/use-assistant-capability", () => ({
  useAssistantCapabilityQuery: () => ({
    data: supported,
    isPending: supported === undefined && !capabilityError,
    isError: capabilityError,
  }),
}));
mock.module("@/hooks/use-is-org-ready", () => ({ useIsOrgReady: () => true }));
mock.module("@/lib/backwards-compat/complete-profile-snapshots", () => ({
  useSupportsCompleteProfileSnapshots: () => true,
}));
const quickAdd = mock(() => {});
mock.module("@/components/profile-quick-add-provider", () => ({
  useProfileQuickAdd: () => ({ openProfileQuickAdd: quickAdd }),
}));
const setGlobal = mock(async () => {});
const overrides = new Map<string, string>();
const setOverride = mock(
  async (_assistant: string, id: string, threshold: string) => {
    overrides.set(id, threshold);
  },
);
mock.module("@/lib/threshold-api", () => ({
  getGlobalThresholds: async () => ({ interactive: "medium" }),
  getConversationOverride: async (_assistant: string, id: string) =>
    overrides.get(id) ?? null,
  setConversationOverride: setOverride,
  setGlobalThresholds: setGlobal,
}));
const fixture = composerConfigurationFixture();
let prefs = { ...fixture.preferences };
const getSettings = mock(async () => ({ data: { preferences: prefs } }));
const modes = new Map<string, string>();
const put = mock(
  async ({
    path,
    body,
  }: {
    path: { id: string };
    body: { profile: string };
  }) => {
    modes.set(path.id, body.profile);
    return { data: {} };
  },
);
const patch = mock(async ({ body }: { body: Partial<typeof prefs> }) => {
  prefs = { ...prefs, ...body };
  return { data: { preferences: prefs } };
});
mock.module("@/generated/daemon/sdk.gen", () => ({
  configGet: async () => ({
    data: {
      llm: {
        profiles: Object.fromEntries(
          fixture.profiles.map(({ name, ...profile }) => [name, profile]),
        ),
        profileOrder: fixture.profiles.map((entry) => entry.name),
        activeProfile: "balanced",
      },
    },
  }),
  conversationsByIdGet: async ({ path }: { path: { id: string } }) => ({
    data: { conversation: { inferenceProfile: modes.get(path.id) ?? null } },
  }),
  composerSettingsGet: getSettings,
  composerSettingsPatch: patch,
  conversationsByIdInferenceprofilePut: put,
}));
import { useComposerConfiguration } from "./use-composer-configuration";
import { useConversationStore } from "@/stores/conversation-store";
import { useComposerStore } from "@/domains/chat/composer-store";

const clients: QueryClient[] = [];
function setup(id: string | null = "conv-1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return renderHook(
    ({ conversationId }: { conversationId: string | undefined }) =>
      useComposerConfiguration("assistant-1", conversationId),
    {
      initialProps: { conversationId: id ?? undefined },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
}
beforeEach(() => {
  supported = true;
  capabilityError = false;
  prefs = { ...fixture.preferences };
  getSettings.mockReset();
  getSettings.mockImplementation(async () => ({
    data: { preferences: prefs },
  }));
  modes.clear();
  overrides.clear();
  useConversationStore.getState().reset();
  useConversationStore.getState().setActiveConversationId("conv-1");
  put.mockReset();
  put.mockImplementation(async ({ path, body }) => {
    modes.set(path.id, body.profile);
    return { data: {} };
  });
  setOverride.mockReset();
  setOverride.mockImplementation(async (_assistant, id, threshold) => {
    overrides.set(id, threshold);
  });
  setGlobal.mockClear();
  patch.mockClear();
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) {
    client.clear();
  }
});

test("draft autonomy remains scoped and defaults snapshot only once", async () => {
  useConversationStore.setState({
    activeConversationId: "draft-1",
    draftConversationIds: new Set(["draft-1"]),
  });
  prefs = { ...prefs, lastModeId: "quality-optimized", lastAutonomy: "low" };
  const hook = setup(null);
  await waitFor(() => expect(hook.result.current.readyForDraft).toBe(true));
  expect(
    useConversationStore.getState().pendingDraftProfiles.get("draft-1"),
  ).toBe("quality-optimized");
  await act(async () => {
    await hook.result.current.selectAutonomy("none");
  });
  expect(
    useConversationStore.getState().pendingDraftAutonomy.get("draft-1"),
  ).toBe("none");
  expect(setGlobal).not.toHaveBeenCalled();
  expect(setOverride).not.toHaveBeenCalled();
  expect(prefs.lastAutonomy).toBe("none");
});
test("a failed capability probe keeps a draft pending until saved choices can load", async () => {
  supported = undefined;
  capabilityError = true;
  useConversationStore.setState({
    activeConversationId: "draft-1",
    draftConversationIds: new Set(["draft-1"]),
  });
  prefs = { ...prefs, lastModeId: "quality-optimized", lastAutonomy: "none" };
  const hook = setup(null);
  await waitFor(() => {
    expect(hook.result.current.modeReady).toBe(true);
    expect(hook.result.current.autonomy).toBe("medium");
  });
  expect(hook.result.current.readyForDraft).toBe(false);
  expect(
    useConversationStore.getState().initializedDraftComposerIds.has("draft-1"),
  ).toBe(false);
  expect(
    useConversationStore.getState().pendingDraftProfiles.has("draft-1"),
  ).toBe(false);

  capabilityError = false;
  hook.rerender({ conversationId: undefined });
  expect(hook.result.current.readyForDraft).toBe(false);

  supported = true;
  hook.rerender({ conversationId: undefined });
  await waitFor(() => expect(hook.result.current.readyForDraft).toBe(true));
  expect(
    useConversationStore.getState().pendingDraftProfiles.get("draft-1"),
  ).toBe("quality-optimized");
  expect(
    useConversationStore.getState().pendingDraftAutonomy.get("draft-1"),
  ).toBe("none");
});
test.each([false, true])(
  "a failed refresh preserves a confirmed capability for new drafts (supported: %s)",
  async (knownSupport) => {
    supported = knownSupport;
    capabilityError = true;
    useConversationStore.setState({
      activeConversationId: "draft-1",
      draftConversationIds: new Set(["draft-1"]),
    });
    prefs = { ...prefs, lastModeId: "quality-optimized", lastAutonomy: "low" };
    const hook = setup(null);
    await waitFor(() => expect(hook.result.current.readyForDraft).toBe(true));
    expect(
      useConversationStore.getState().pendingDraftProfiles.get("draft-1"),
    ).toBe(knownSupport ? "quality-optimized" : "balanced");
    expect(
      useConversationStore.getState().pendingDraftAutonomy.get("draft-1"),
    ).toBe(knownSupport ? "low" : undefined);
  },
);
test("existing conversations never inherit last-used settings on open", async () => {
  prefs = { ...prefs, lastModeId: "quality-optimized", lastAutonomy: "high" };
  const hook = setup();
  await waitFor(() => expect(hook.result.current.modeReady).toBe(true));
  expect(hook.result.current.mode).toBe("balanced");
  expect(hook.result.current.autonomy).toBe("medium");
  expect(put).not.toHaveBeenCalled();
  expect(setOverride).not.toHaveBeenCalled();
});
test("an existing chat gets an explicit override even when matching the global default", async () => {
  const hook = setup();
  await waitFor(() => expect(hook.result.current.autonomyReady).toBe(true));
  await act(async () => {
    await hook.result.current.selectAutonomy("medium");
  });
  expect(setOverride).toHaveBeenCalledWith("assistant-1", "conv-1", "medium");
  expect(setGlobal).not.toHaveBeenCalled();
});
test("rapid mode changes are serialized and the latest choice wins", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  put.mockImplementation(async ({ path, body }) => {
    if (body.profile === "quality-optimized") {
      await gate;
    }
    modes.set(path.id, body.profile);
    return { data: {} };
  });
  const hook = setup();
  await waitFor(() => expect(hook.result.current.modeReady).toBe(true));
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  act(() => {
    first = hook.result.current.selectMode("quality-optimized");
    second = hook.result.current.selectMode("latency-optimized");
  });
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  expect(hook.result.current.mode).toBe("latency-optimized");
  expect(hook.result.current.readyForDraft).toBe(false);
  await act(async () => {
    release();
    await Promise.all([first, second]);
  });
  expect(modes.get("conv-1")).toBe("latency-optimized");
  expect(prefs.lastModeId).toBe("latency-optimized");
  expect(prefs.favoriteModeIds).toEqual([
    "auto",
    "balanced",
    "quality-optimized",
    "latency-optimized",
    "cost-optimized",
  ]);
});
test("failed saves restore the confirmed value and preserve preferences", async () => {
  const hook = setup();
  await waitFor(() => expect(hook.result.current.modeReady).toBe(true));
  put.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    expect(await hook.result.current.selectMode("quality-optimized")).toBe(
      false,
    );
  });
  expect(hook.result.current.mode).toBe("balanced");
  expect(prefs.lastModeId).toBeNull();
});
test("model changes wait for saved favorites before updating preferences", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  prefs = { ...prefs, favoriteModeIds: ["os-beta", "balanced"] };
  getSettings.mockImplementation(async () => {
    await gate;
    return { data: { preferences: prefs } };
  });
  const hook = setup();
  await waitFor(() => expect(hook.result.current.modeReady).toBe(true));
  let pending!: Promise<boolean>;
  act(() => {
    pending = hook.result.current.selectMode("quality-optimized");
  });
  await waitFor(() => expect(modes.get("conv-1")).toBe("quality-optimized"));
  expect(patch).not.toHaveBeenCalled();
  await act(async () => {
    release();
    expect(await pending).toBe(true);
  });
  expect(prefs.favoriteModeIds).toContain("os-beta");
  expect(prefs.lastModeId).toBe("quality-optimized");
});
test("failed preference reads cannot replace saved favorites with defaults", async () => {
  prefs = { ...prefs, favoriteModeIds: ["os-beta", "balanced"] };
  getSettings.mockRejectedValue(new Error("offline"));
  const hook = setup();
  await waitFor(() => expect(hook.result.current.modeReady).toBe(true));
  await act(async () => {
    expect(await hook.result.current.selectMode("quality-optimized")).toBe(
      true,
    );
  });
  expect(patch).not.toHaveBeenCalled();
  expect(prefs.favoriteModeIds).toEqual(["os-beta", "balanced"]);
  expect(modes.get("conv-1")).toBe("quality-optimized");
});
test.each(["mode", "autonomy"] as const)(
  "a failed pending %s promotion restores the confirmed choice",
  async (kind) => {
    if (kind === "mode") {
      useConversationStore
        .getState()
        .setPendingDraftProfile("conv-1", "quality-optimized");
      put.mockRejectedValueOnce(new Error("offline"));
    } else {
      useConversationStore.getState().setPendingDraftAutonomy("conv-1", "none");
      setOverride.mockRejectedValueOnce(new Error("offline"));
    }
    const hook = setup();
    await waitFor(() => {
      expect(hook.result.current[kind]).toBe(
        kind === "mode" ? "balanced" : "medium",
      );
    });
    expect(
      useConversationStore.getState().pendingDraftProfiles.has("conv-1"),
    ).toBe(false);
    expect(
      useConversationStore.getState().pendingDraftAutonomy.has("conv-1"),
    ).toBe(false);
    expect(kind === "mode" ? put : setOverride).toHaveBeenCalledTimes(1);
  },
);
test.each([false, true])(
  "a newer pending choice is promoted after an in-flight save settles (failed: %s)",
  async (failed) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    put.mockImplementationOnce(async ({ path, body }) => {
      await gate;
      if (failed) {
        throw new Error("offline");
      }
      modes.set(path.id, body.profile);
      return { data: {} };
    });
    useConversationStore
      .getState()
      .setPendingDraftProfile("conv-1", "quality-optimized");
    const hook = setup();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    act(() => {
      useConversationStore
        .getState()
        .setPendingDraftProfile("conv-1", "latency-optimized");
    });
    await act(async () => {
      release();
    });
    await waitFor(() => {
      expect(modes.get("conv-1")).toBe("latency-optimized");
      expect(
        useConversationStore.getState().pendingDraftProfiles.has("conv-1"),
      ).toBe(false);
    });
    expect(hook.result.current.mode).toBe("latency-optimized");
    expect(put).toHaveBeenCalledTimes(2);
  },
);
test("a save finishing in another chat cannot replace its selection", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  put.mockImplementation(async ({ path, body }) => {
    await gate;
    modes.set(path.id, body.profile);
    return { data: {} };
  });
  const hook = setup();
  await waitFor(() => expect(hook.result.current.modeReady).toBe(true));
  let pending!: Promise<boolean>;
  act(() => {
    pending = hook.result.current.selectMode("quality-optimized");
  });
  act(() => {
    useConversationStore.getState().setActiveConversationId("conv-2");
    hook.rerender({ conversationId: "conv-2" });
  });
  await act(async () => {
    release();
    await pending;
  });
  expect(hook.result.current.mode).toBe("balanced");
  expect(modes.get("conv-2")).toBeUndefined();
});
test("legacy assistants retain existing-chat controls without calling the preferences endpoint", async () => {
  supported = false;
  const hook = setup();
  await waitFor(() => expect(hook.result.current.autonomyReady).toBe(true));
  await act(async () => {
    await hook.result.current.selectAutonomy("low");
  });
  expect(setOverride).toHaveBeenCalled();
  expect(patch).not.toHaveBeenCalled();
});

test("queued selections cannot write using a later login session", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  put.mockImplementation(async () => {
    await gate;
    return { data: {} };
  });
  const hook = setup();
  await waitFor(() => expect(hook.result.current.modeReady).toBe(true));
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  act(() => {
    first = hook.result.current.selectMode("quality-optimized");
    second = hook.result.current.selectMode("latency-optimized");
  });
  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  await act(async () => {
    useComposerStore.getState().resetForLogout();
    release();
    expect(await Promise.all([first, second])).toEqual([false, false]);
  });
  expect(put).toHaveBeenCalledTimes(1);
  expect(patch).not.toHaveBeenCalled();
});
