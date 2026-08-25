/**
 * Tests for `useChooserRowAvatar`: the transport gate that decides whether a
 * per-row SDK fetch is addressable, connected-row delegation to
 * `useAssistantAvatar`, per-row manifest-vs-legacy path selection, and the
 * failure-to-nulls contract. The resolved-assistants store is real; the
 * environment probes and the avatar API are mocked at the module boundary.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import type * as AvatarApi from "@/assistant/avatar-api";
import type { ResolvedAssistant } from "@/stores/resolved-assistants-store";
import type {
  AvatarState,
  CharacterComponents,
  CharacterTraits,
} from "@/types/avatar";

const actualLocalMode = await import("@/lib/local-mode");
let localClient = false;
let remoteGatewayMode = false;
mock.module("@/lib/local-mode", () => ({
  ...actualLocalMode,
  isLocalClient: () => localClient,
  isRemoteGatewayMode: () => remoteGatewayMode,
}));

let gatewayAuthEnabled = false;
mock.module("@/lib/auth/gateway-session", () => ({
  isGatewayAuthEnabled: () => gatewayAuthEnabled,
}));

let selfHostedIngressUrl: string | null = null;
mock.module("@/lib/self-hosted/connection", () => ({
  getSelfHostedIngressUrl: () => selfHostedIngressUrl,
}));

let orgReady = true;
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));

const traits: CharacterTraits = {
  bodyShape: "brontosaurus",
  eyeStyle: "curious",
  color: "cosmic-purple",
};

const components: CharacterComponents = {
  bodyShapes: [],
  eyeStyles: [],
  colors: [],
  faceCenterOverrides: [],
};

const characterState: AvatarState = {
  kind: "character",
  traits,
  source: "builder",
  image: { updatedAt: "2024-01-01T00:00:00Z", etag: "abc" },
};

const imageState: AvatarState = {
  kind: "image",
  traits: null,
  source: "upload",
  image: { updatedAt: "2024-01-01T00:00:00Z", etag: "def" },
};

const fetchAvatarState = mock(async () => characterState as AvatarState | null);
const fetchAvatarImageUrl = mock(async () => null as string | null);
const fetchCharacterTraits = mock(async () => null as CharacterTraits | null);
const fetchCharacterComponents = mock(async () => components);

const avatarApiMock: Partial<typeof AvatarApi> = {
  fetchAvatarState,
  fetchAvatarImageUrl,
  fetchCharacterTraits,
  fetchCharacterComponents,
};
mock.module("@/assistant/avatar-api", () => avatarApiMock);

const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
const { MIN_VERSION } =
  await import("@/lib/backwards-compat/avatar-state-manifest");
const {
  canFetchRowAvatarViaPlatformProxy,
  chooserRowAvatarQueryKeyPrefix,
  useChooserRowAvatar,
} = await import("@/hooks/use-chooser-row-avatar");

const platformRow = (
  id: string,
  overrides: Partial<ResolvedAssistant> = {},
): ResolvedAssistant => ({
  id,
  isLocal: false,
  isPlatformHosted: true,
  isPaired: false,
  runtimeVersion: "0.9.0",
  ...overrides,
});

function createWrapper(
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function sdkCallCount(): number {
  return (
    fetchAvatarState.mock.calls.length +
    fetchAvatarImageUrl.mock.calls.length +
    fetchCharacterTraits.mock.calls.length +
    fetchCharacterComponents.mock.calls.length
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  localClient = false;
  remoteGatewayMode = false;
  gatewayAuthEnabled = false;
  selfHostedIngressUrl = null;
  orgReady = true;
  useResolvedAssistantsStore.getState().setActiveAssistantId("active");
  // useAssistantAvatar gates its own path on the identity store's version.
  useAssistantIdentityStore.getState().setIdentity("active", MIN_VERSION);
});

afterEach(() => {
  cleanup();
  useResolvedAssistantsStore.getState().setActiveAssistantId(null);
  useAssistantIdentityStore.getState().clearIdentity();
  fetchAvatarState.mockReset();
  fetchAvatarImageUrl.mockReset();
  fetchCharacterTraits.mockReset();
  fetchCharacterComponents.mockReset();
  fetchAvatarState.mockResolvedValue(characterState);
  fetchAvatarImageUrl.mockResolvedValue(null);
  fetchCharacterTraits.mockResolvedValue(null);
  fetchCharacterComponents.mockResolvedValue(components);
});

describe("canFetchRowAvatarViaPlatformProxy", () => {
  test("is open for a platform row in pure cloud mode", () => {
    expect(canFetchRowAvatarViaPlatformProxy(platformRow("a"))).toBe(true);
  });

  test.each([
    ["local client", () => (localClient = true)],
    ["remote-gateway mode", () => (remoteGatewayMode = true)],
    ["gateway auth", () => (gatewayAuthEnabled = true)],
    [
      "self-hosted ingress",
      () => (selfHostedIngressUrl = "https://gw.example"),
    ],
  ])("is closed under %s", (_label, arrange) => {
    arrange();
    expect(canFetchRowAvatarViaPlatformProxy(platformRow("a"))).toBe(false);
  });

  test.each([
    ["local", { isLocal: true, isPlatformHosted: false }],
    ["paired", { isPaired: true, isPlatformHosted: false }],
  ])("is closed for a %s row", (_label, overrides) => {
    expect(canFetchRowAvatarViaPlatformProxy(platformRow("a", overrides))).toBe(
      false,
    );
  });
});

describe("useChooserRowAvatar", () => {
  test.each([
    ["local client", () => (localClient = true)],
    ["remote-gateway mode", () => (remoteGatewayMode = true)],
    ["gateway auth", () => (gatewayAuthEnabled = true)],
    [
      "self-hosted ingress",
      () => (selfHostedIngressUrl = "https://gw.example"),
    ],
  ])(
    "issues zero SDK calls for a non-connected row under %s",
    async (_l, arrange) => {
      arrange();
      const { result } = renderHook(
        () => useChooserRowAvatar(platformRow("other")),
        { wrapper: createWrapper() },
      );
      await settle();
      expect(result.current).toEqual({ traits: null, imageUrl: null });
      expect(sdkCallCount()).toBe(0);
    },
  );

  test.each([
    ["local", { isLocal: true, isPlatformHosted: false }],
    ["paired", { isPaired: true, isPlatformHosted: false }],
  ])(
    "issues zero SDK calls for a non-connected %s row",
    async (_l, overrides) => {
      const { result } = renderHook(
        () => useChooserRowAvatar(platformRow("other", overrides)),
        { wrapper: createWrapper() },
      );
      await settle();
      expect(result.current).toEqual({ traits: null, imageUrl: null });
      expect(sdkCallCount()).toBe(0);
    },
  );

  test("waits for org readiness before the first platform-proxy fetch", async () => {
    orgReady = false;
    const { result, rerender } = renderHook(
      () => useChooserRowAvatar(platformRow("other")),
      { wrapper: createWrapper() },
    );
    await settle();
    expect(result.current).toEqual({ traits: null, imageUrl: null });
    expect(sdkCallCount()).toBe(0);

    orgReady = true;
    rerender();
    await waitFor(() => {
      expect(result.current.traits).toEqual(traits);
    });
    expect(fetchAvatarState).toHaveBeenCalledWith("other");
    expect(fetchAvatarState).toHaveBeenCalledTimes(1);
  });

  test("connected row delegates to useAssistantAvatar even when the gate is closed", async () => {
    localClient = true;
    const { result } = renderHook(
      () => useChooserRowAvatar(platformRow("active", { isLocal: true })),
      { wrapper: createWrapper() },
    );
    await waitFor(() => {
      expect(result.current.traits).toEqual(traits);
    });
    expect(result.current.imageUrl).toBeNull();
    // useAssistantAvatar's signature: components + state, no chooser fetch.
    expect(fetchCharacterComponents).toHaveBeenCalledTimes(1);
    expect(fetchAvatarState).toHaveBeenCalledTimes(1);
  });

  test("connected row reuses the useAssistantAvatar cache across consumers", async () => {
    const wrapper = createWrapper();
    const first = renderHook(() => useChooserRowAvatar(platformRow("active")), {
      wrapper,
    });
    await waitFor(() => {
      expect(first.result.current.traits).toEqual(traits);
    });
    const second = renderHook(
      () => useChooserRowAvatar(platformRow("active")),
      { wrapper },
    );
    await waitFor(() => {
      expect(second.result.current.traits).toEqual(traits);
    });
    expect(fetchAvatarState).toHaveBeenCalledTimes(1);
    expect(fetchCharacterComponents).toHaveBeenCalledTimes(1);
  });

  test("manifest-capable platform row reads /avatar/state and skips components", async () => {
    const { result } = renderHook(
      () => useChooserRowAvatar(platformRow("other")),
      { wrapper: createWrapper() },
    );
    await waitFor(() => {
      expect(result.current.traits).toEqual(traits);
    });
    expect(fetchAvatarState).toHaveBeenCalledWith("other");
    expect(fetchCharacterComponents).not.toHaveBeenCalled();
    expect(fetchAvatarImageUrl).not.toHaveBeenCalled();
  });

  test("image kind resolves the blob url", async () => {
    fetchAvatarState.mockResolvedValue(imageState);
    fetchAvatarImageUrl.mockResolvedValue("blob:row-image");
    const { result } = renderHook(
      () => useChooserRowAvatar(platformRow("other")),
      { wrapper: createWrapper() },
    );
    await waitFor(() => {
      expect(result.current.imageUrl).toBe("blob:row-image");
    });
    expect(result.current.traits).toBeNull();
  });

  test("pre-manifest platform row reads the legacy sidecars only", async () => {
    fetchCharacterTraits.mockResolvedValue(traits);
    const { result } = renderHook(
      () =>
        useChooserRowAvatar(
          platformRow("other", {
            runtimeVersion: undefined,
            currentReleaseVersion: "0.8.6",
          }),
        ),
      { wrapper: createWrapper() },
    );
    await waitFor(() => {
      expect(result.current.traits).toEqual(traits);
    });
    expect(fetchAvatarState).not.toHaveBeenCalled();
    expect(fetchAvatarImageUrl).toHaveBeenCalledWith("other");
  });

  test("unknown version probes the manifest, then falls back to sidecars", async () => {
    fetchAvatarState.mockResolvedValue(null);
    fetchAvatarImageUrl.mockResolvedValue("blob:legacy");
    const { result } = renderHook(
      () =>
        useChooserRowAvatar(
          platformRow("other", {
            runtimeVersion: undefined,
            currentReleaseVersion: null,
          }),
        ),
      { wrapper: createWrapper() },
    );
    await waitFor(() => {
      expect(result.current.imageUrl).toBe("blob:legacy");
    });
    expect(fetchAvatarState).toHaveBeenCalledTimes(1);
    expect(fetchCharacterTraits).not.toHaveBeenCalled();
  });

  test("failures resolve to nulls, never an error", async () => {
    fetchAvatarState.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(
      () => useChooserRowAvatar(platformRow("other")),
      { wrapper: createWrapper() },
    );
    await waitFor(() => {
      expect(fetchAvatarState).toHaveBeenCalledTimes(1);
    });
    await settle();
    expect(result.current).toEqual({ traits: null, imageUrl: null });
  });

  test("re-keys on a version change so an upgraded row switches paths", async () => {
    fetchCharacterTraits.mockResolvedValue(traits);
    const { result, rerender } = renderHook(
      (version: string) =>
        useChooserRowAvatar(platformRow("other", { runtimeVersion: version })),
      { wrapper: createWrapper(), initialProps: "0.8.6" },
    );
    await waitFor(() => {
      expect(result.current.traits).toEqual(traits);
    });
    expect(fetchAvatarState).not.toHaveBeenCalled();
    expect(fetchCharacterTraits).toHaveBeenCalledTimes(1);

    rerender(MIN_VERSION);
    await waitFor(() => {
      expect(fetchAvatarState).toHaveBeenCalledWith("other");
    });
    await waitFor(() => {
      expect(result.current.traits).toEqual(traits);
    });
    expect(fetchCharacterTraits).toHaveBeenCalledTimes(1);
  });

  test("invalidating the row prefix refetches past staleTime: Infinity", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () => useChooserRowAvatar(platformRow("other")),
      { wrapper: createWrapper(queryClient) },
    );
    await waitFor(() => {
      expect(result.current.traits).toEqual(traits);
    });
    expect(fetchAvatarState).toHaveBeenCalledTimes(1);

    const updated: CharacterTraits = { ...traits, color: "sunset-orange" };
    fetchAvatarState.mockResolvedValue({ ...characterState, traits: updated });
    await queryClient.invalidateQueries({
      queryKey: chooserRowAvatarQueryKeyPrefix("other"),
    });
    await waitFor(() => {
      expect(result.current.traits).toEqual(updated);
    });
    expect(fetchAvatarState).toHaveBeenCalledTimes(2);
  });

  test("keys the fetch per row id", async () => {
    const wrapper = createWrapper();
    const a = renderHook(() => useChooserRowAvatar(platformRow("a")), {
      wrapper,
    });
    const b = renderHook(() => useChooserRowAvatar(platformRow("b")), {
      wrapper,
    });
    await waitFor(() => {
      expect(a.result.current.traits).toEqual(traits);
      expect(b.result.current.traits).toEqual(traits);
    });
    expect(fetchAvatarState).toHaveBeenCalledWith("a");
    expect(fetchAvatarState).toHaveBeenCalledWith("b");
    expect(fetchAvatarState).toHaveBeenCalledTimes(2);
  });
});
