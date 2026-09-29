import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { composerConfigurationFixture } from "@/domains/chat/components/composer-configuration.test-utils";
import type { useProfileQuickAdd } from "@/components/profile-quick-add-provider";
import { configGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";

let supported: boolean | undefined = true;
let capabilityError = false;
mock.module("@/hooks/use-assistant-capability", () => ({
  assistantCapabilityOptions: () => ({
    queryKey: ["test-capability"],
    queryFn: async () => supported,
  }),
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
const quickAdd = mock(
  (
    ..._args: Parameters<
      ReturnType<typeof useProfileQuickAdd>["openProfileQuickAdd"]
    >
  ) => {},
);
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
function setup(id: string | null = "conv-1", existingClient?: QueryClient) {
  const client =
    existingClient ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  clients.push(client);
  const hook = renderHook(
    ({ conversationId }: { conversationId: string | undefined }) =>
      useComposerConfiguration("assistant-1", conversationId),
    {
      initialProps: { conversationId: id ?? undefined },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return { ...hook, client };
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
  quickAdd.mockClear();
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
test.each(["mode", "autonomy"] as const)(
  "last-used %s follows selection order across composer remounts",
  async (kind) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (kind === "mode") {
      put.mockImplementationOnce(async ({ path, body }) => {
        await gate;
        modes.set(path.id, body.profile);
        return { data: {} };
      });
    } else {
      setOverride.mockImplementationOnce(async (_assistant, id, threshold) => {
        await gate;
        overrides.set(id, threshold);
      });
    }
    const first = setup();
    await waitFor(() => expect(first.result.current.autonomyReady).toBe(true));
    let earlier!: Promise<boolean>;
    act(() => {
      earlier =
        kind === "mode"
          ? first.result.current.selectMode("os-beta")
          : first.result.current.selectAutonomy("none");
    });
    await waitFor(() =>
      expect(kind === "mode" ? put : setOverride).toHaveBeenCalledTimes(1),
    );
    first.unmount();
    const second = setup("conv-2", first.client);
    await waitFor(() => expect(second.result.current.autonomyReady).toBe(true));
    let later!: Promise<boolean>;
    act(() => {
      later =
        kind === "mode"
          ? second.result.current.selectMode("latency-optimized")
          : second.result.current.selectAutonomy("high");
    });
    await waitFor(() => {
      expect(
        kind === "mode" ? modes.get("conv-2") : overrides.get("conv-2"),
      ).toBe(kind === "mode" ? "latency-optimized" : "high");
    });
    await act(async () => {
      release();
      expect(await Promise.all([earlier, later])).toEqual([true, true]);
    });
    if (kind === "mode") {
      expect(prefs.lastModeId).toBe("latency-optimized");
      expect(prefs.favoriteModeIds).toContain("os-beta");
    } else {
      expect(prefs.lastAutonomy).toBe("high");
    }
  },
);
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
test("a newly created model is saved as a favorite from the current config cache", async () => {
  const hook = setup();
  await waitFor(() => expect(hook.result.current.modeReady).toBe(true));
  act(() => hook.result.current.newMode());
  const onCreated = quickAdd.mock.calls[0][0]?.onCreated;
  expect(onCreated).toBeDefined();
  act(() => {
    hook.client.setQueryData(
      configGetQueryKey({ path: { assistant_id: "assistant-1" } }),
      {
        llm: {
          activeProfile: "balanced",
          profiles: {
            ...Object.fromEntries(
              fixture.profiles.map(({ name, ...profile }) => [name, profile]),
            ),
            "custom-new": {
              label: "Custom",
              provider: "anthropic",
              model: "claude-fable-5",
            },
          },
          profileOrder: [
            ...fixture.profiles.map((entry) => entry.name),
            "custom-new",
          ],
        },
      },
    );
    onCreated?.("custom-new", "Custom");
  });
  await waitFor(() => expect(prefs.lastModeId).toBe("custom-new"));
  expect(prefs.favoriteModeIds).toContain("custom-new");
  await act(async () => {
    await hook.result.current.selectMode("balanced");
  });
  expect(prefs.favoriteModeIds).toContain("custom-new");
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
