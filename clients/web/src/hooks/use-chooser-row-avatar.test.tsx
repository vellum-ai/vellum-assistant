/**
 * Tests for `useChooserRowAvatar`: the transport gate that decides whether a
 * per-row SDK fetch is addressable, connected-row delegation to
 * `useAssistantAvatar`, per-row manifest-vs-legacy path selection, the
 * host-bridge disk read for local rows, the last-seen cache as the final
 * fallback, and the failure-to-nulls contract. The resolved-assistants store
 * is real; the environment probes, the avatar API, the host bridge, and the
 * IndexedDB cache are mocked at the module boundary.
 */

import type { ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import type * as AvatarApi from "@/assistant/avatar-api";
import type * as AvatarLastSeenCache from "@/lib/avatar-last-seen-cache";
import type { LocalReadAssistantAvatarResult } from "@vellumai/ipc-contract";
import type * as LocalModeHost from "@/runtime/local-mode-host";
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

type HostAvatarResult = LocalReadAssistantAvatarResult;
let hostAvailable = false;
const readAssistantAvatarHost = mock(
  async (_id: string): Promise<HostAvatarResult> => ({
    ok: true,
    avatar: null,
  }),
);
mock.module("@/runtime/local-mode-host", (): Partial<typeof LocalModeHost> => ({
  canReadAvatarFromLocalHost: () => hostAvailable,
  readAssistantAvatarHost,
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
type FileResult<T> = AvatarApi.AvatarFileResult<T>;
const ABSENT: FileResult<never> = { status: "absent" };
const FAILED: FileResult<never> = { status: "failed" };
const found = <T,>(value: T): FileResult<T> => ({ status: "found", value });
const fetchAvatarImageUrlResult = mock(
  async () => ABSENT as FileResult<string>,
);
const fetchCharacterTraitsResult = mock(
  async () => ABSENT as FileResult<CharacterTraits>,
);
const fetchCharacterComponents = mock(async () => components);

const avatarApiMock: Partial<typeof AvatarApi> = {
  fetchAvatarState,
  fetchAvatarImageUrlResult,
  fetchCharacterTraitsResult,
  fetchCharacterComponents,
};
mock.module("@/assistant/avatar-api", () => avatarApiMock);

type LastSeenAvatar = AvatarLastSeenCache.LastSeenAvatar;
const actualLastSeenCache = await import("@/lib/avatar-last-seen-cache");
const readLastSeenAvatar = mock(async () => null as LastSeenAvatar | null);
const writeLastSeenAvatar = mock(async (_id: string, _v: LastSeenAvatar) => {});
const deleteLastSeenAvatar = mock(async (_id: string) => {});
// The generation helpers stay real so the hook's write guard is exercised.
mock.module(
  "@/lib/avatar-last-seen-cache",
  (): Partial<typeof AvatarLastSeenCache> => ({
    ...actualLastSeenCache,
    readLastSeenAvatar,
    writeLastSeenAvatar,
    deleteLastSeenAvatar,
  }),
);

const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
const { MIN_VERSION } =
  await import("@/lib/backwards-compat/avatar-state-manifest");
const {
  canFetchRowAvatarViaPlatformProxy,
  chooserRowAvatarQueryKeyPrefix,
  forgetAssistantAvatar,
  useChooserRowAvatar,
} = await import("@/hooks/use-chooser-row-avatar");
const { avatarQueryKey } = await import("@/hooks/use-assistant-avatar");
const { chooserRowAvatarCacheQueryKey } =
  await import("@/lib/persist-last-seen-avatar");

/** Past the window a bare avatar stays fresh for. */
const A_MINUTE_LATER = 61_000;

const revokeObjectURL = mock((_url: string) => {});
URL.revokeObjectURL = revokeObjectURL;
URL.createObjectURL = () => "blob:cached-image";

const noneState: AvatarState = {
  kind: "none",
  traits: null,
  source: null,
  image: null,
};

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

const localRow = (
  id: string,
  overrides: Partial<ResolvedAssistant> = {},
): ResolvedAssistant =>
  platformRow(id, {
    isLocal: true,
    isPlatformHosted: false,
    cloud: "local",
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
    fetchAvatarImageUrlResult.mock.calls.length +
    fetchCharacterTraitsResult.mock.calls.length +
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
  hostAvailable = false;
  useResolvedAssistantsStore.getState().setActiveAssistantId("active");
  // useAssistantAvatar gates its own path on the identity store's version.
  useAssistantIdentityStore.getState().setIdentity("active", MIN_VERSION);
});

afterEach(() => {
  cleanup();
  setSystemTime();
  revokeObjectURL.mockClear();
  useResolvedAssistantsStore.getState().setActiveAssistantId(null);
  useAssistantIdentityStore.getState().clearIdentity();
  fetchAvatarState.mockReset();
  fetchAvatarImageUrlResult.mockReset();
  fetchCharacterTraitsResult.mockReset();
  fetchCharacterComponents.mockReset();
  readLastSeenAvatar.mockReset();
  writeLastSeenAvatar.mockReset();
  deleteLastSeenAvatar.mockReset();
  readAssistantAvatarHost.mockReset();
  readAssistantAvatarHost.mockResolvedValue({ ok: true, avatar: null });
  readLastSeenAvatar.mockResolvedValue(null);
  fetchAvatarState.mockResolvedValue(characterState);
  fetchAvatarImageUrlResult.mockResolvedValue(ABSENT);
  fetchCharacterTraitsResult.mockResolvedValue(ABSENT);
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
    expect(fetchAvatarImageUrlResult).not.toHaveBeenCalled();
  });

  test("image kind resolves the blob url", async () => {
    fetchAvatarState.mockResolvedValue(imageState);
    fetchAvatarImageUrlResult.mockResolvedValue(found("blob:row-image"));
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
    fetchCharacterTraitsResult.mockResolvedValue(found(traits));
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
    expect(fetchAvatarImageUrlResult).toHaveBeenCalledWith("other");
  });

  test("unknown version probes the manifest, then falls back to sidecars", async () => {
    fetchAvatarState.mockResolvedValue(null);
    fetchAvatarImageUrlResult.mockResolvedValue(found("blob:legacy"));
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
    expect(fetchCharacterTraitsResult).not.toHaveBeenCalled();
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
    fetchCharacterTraitsResult.mockResolvedValue(found(traits));
    const { result, rerender } = renderHook(
      (version: string) =>
        useChooserRowAvatar(platformRow("other", { runtimeVersion: version })),
      { wrapper: createWrapper(), initialProps: "0.8.6" },
    );
    await waitFor(() => {
      expect(result.current.traits).toEqual(traits);
    });
    expect(fetchAvatarState).not.toHaveBeenCalled();
    expect(fetchCharacterTraitsResult).toHaveBeenCalledTimes(1);

    rerender(MIN_VERSION);
    await waitFor(() => {
      expect(fetchAvatarState).toHaveBeenCalledWith("other");
    });
    await waitFor(() => {
      expect(result.current.traits).toEqual(traits);
    });
    expect(fetchCharacterTraitsResult).toHaveBeenCalledTimes(1);
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

  test("an empty legacy result goes stale so a later mount refetches it", async () => {
    const wrapper = createWrapper();
    const row = platformRow("other", { runtimeVersion: "0.8.6" });
    const first = renderHook(() => useChooserRowAvatar(row), { wrapper });
    await waitFor(() => {
      expect(fetchCharacterTraitsResult).toHaveBeenCalledTimes(1);
    });
    await settle();
    expect(first.result.current).toEqual({ traits: null, imageUrl: null });
    first.unmount();

    setSystemTime(new Date(Date.now() + A_MINUTE_LATER));
    fetchCharacterTraitsResult.mockResolvedValue(found(traits));
    const second = renderHook(() => useChooserRowAvatar(row), { wrapper });
    await waitFor(() => {
      expect(second.result.current.traits).toEqual(traits);
    });
    expect(fetchCharacterTraitsResult).toHaveBeenCalledTimes(2);
  });

  test("a populated legacy result stays cached past the empty stale window", async () => {
    const wrapper = createWrapper();
    const row = platformRow("other", { runtimeVersion: "0.8.6" });
    fetchCharacterTraitsResult.mockResolvedValue(found(traits));
    const first = renderHook(() => useChooserRowAvatar(row), { wrapper });
    await waitFor(() => {
      expect(first.result.current.traits).toEqual(traits);
    });
    first.unmount();

    setSystemTime(new Date(Date.now() + A_MINUTE_LATER));
    const second = renderHook(() => useChooserRowAvatar(row), { wrapper });
    await waitFor(() => {
      expect(second.result.current.traits).toEqual(traits);
    });
    await settle();
    expect(fetchCharacterTraitsResult).toHaveBeenCalledTimes(1);
  });

  test("a superseded fetch that finishes last drops its own blob, not the current one", async () => {
    let resolveOld: (result: FileResult<string>) => void = () => {};
    const oldImage = new Promise<FileResult<string>>((resolve) => {
      resolveOld = resolve;
    });
    fetchAvatarImageUrlResult.mockImplementationOnce(() => oldImage);
    fetchAvatarImageUrlResult.mockResolvedValue(found("blob:new"));
    fetchAvatarState.mockResolvedValue(imageState);

    const { result, rerender } = renderHook(
      (version: string) =>
        useChooserRowAvatar(platformRow("other", { runtimeVersion: version })),
      { wrapper: createWrapper(), initialProps: "0.8.6" },
    );
    await waitFor(() => {
      expect(fetchAvatarImageUrlResult).toHaveBeenCalledTimes(1);
    });

    rerender(MIN_VERSION);
    await waitFor(() => {
      expect(result.current.imageUrl).toBe("blob:new");
    });

    resolveOld(found("blob:old"));
    await waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:old");
    });
    await settle();
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:new");
    expect(result.current.imageUrl).toBe("blob:new");
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

  describe("host bridge", () => {
    beforeEach(() => {
      localClient = true;
      hostAvailable = true;
    });

    test("a local row resolves character traits from the host", async () => {
      readAssistantAvatarHost.mockResolvedValue({
        ok: true,
        avatar: { kind: "character", traits },
      });
      const { result } = renderHook(
        () => useChooserRowAvatar(localRow("other")),
        {
          wrapper: createWrapper(),
        },
      );
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      expect(result.current.imageUrl).toBeNull();
      expect(readAssistantAvatarHost).toHaveBeenCalledWith("other");
      expect(sdkCallCount()).toBe(0);
    });

    test("a local row resolves an image as a data url", async () => {
      readAssistantAvatarHost.mockResolvedValue({
        ok: true,
        avatar: { kind: "image", imageBase64: "cG5n" },
      });
      const { result } = renderHook(
        () => useChooserRowAvatar(localRow("other")),
        {
          wrapper: createWrapper(),
        },
      );
      await waitFor(() => {
        expect(result.current.imageUrl).toBe("data:image/png;base64,cG5n");
      });
      expect(result.current.traits).toBeNull();
    });

    test("a host failure falls through to the last-seen cache", async () => {
      readAssistantAvatarHost.mockResolvedValue({ ok: false, error: "nope" });
      readLastSeenAvatar.mockResolvedValue({ kind: "character", traits });
      const { result } = renderHook(
        () => useChooserRowAvatar(localRow("other")),
        {
          wrapper: createWrapper(),
        },
      );
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      expect(readAssistantAvatarHost).toHaveBeenCalledTimes(1);
      expect(readLastSeenAvatar).toHaveBeenCalledWith("other");
      expect(deleteLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("a host read with no avatar is conclusive: it evicts the cache and shows the glyph", async () => {
      readAssistantAvatarHost.mockResolvedValue({ ok: true, avatar: null });
      readLastSeenAvatar.mockResolvedValue({ kind: "character", traits });
      const { result } = renderHook(
        () => useChooserRowAvatar(localRow("other")),
        {
          wrapper: createWrapper(),
        },
      );
      await waitFor(() => {
        expect(deleteLastSeenAvatar).toHaveBeenCalledWith(
          "other",
          expect.any(Number),
        );
      });
      await settle();
      expect(result.current).toEqual({ traits: null, imageUrl: null });
      expect(writeLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("a stale host none does not evict an entry persisted while it was in flight", async () => {
      let resolveHost!: (v: { ok: true; avatar: null }) => void;
      readAssistantAvatarHost.mockReturnValue(
        new Promise((resolve) => {
          resolveHost = resolve;
        }),
      );
      const { result } = renderHook(
        () => useChooserRowAvatar(localRow("other")),
        {
          wrapper: createWrapper(),
        },
      );
      await waitFor(() => {
        expect(readAssistantAvatarHost).toHaveBeenCalledTimes(1);
      });
      // A newer live persist supersedes the host read's claim.
      actualLastSeenCache.lastSeenAvatarGenerations.claim("other");
      resolveHost({ ok: true, avatar: null });
      await settle();
      expect(result.current).toEqual({ traits: null, imageUrl: null });
      expect(deleteLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("a host read never advances the last-seen generation", async () => {
      const before =
        actualLastSeenCache.lastSeenAvatarGenerations.current("other");
      readAssistantAvatarHost.mockResolvedValue({
        ok: true,
        avatar: { kind: "character", traits },
      });
      const { result } = renderHook(
        () => useChooserRowAvatar(localRow("other")),
        {
          wrapper: createWrapper(),
        },
      );
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      expect(
        actualLastSeenCache.lastSeenAvatarGenerations.current("other"),
      ).toBe(before);
    });

    test("resolves to nulls when the host and the cache have nothing", async () => {
      const { result } = renderHook(
        () => useChooserRowAvatar(localRow("other")),
        {
          wrapper: createWrapper(),
        },
      );
      await waitFor(() => {
        expect(readAssistantAvatarHost).toHaveBeenCalledTimes(1);
      });
      await settle();
      expect(result.current).toEqual({ traits: null, imageUrl: null });
    });

    test("issues no host call when the host is unavailable", async () => {
      hostAvailable = false;
      const { result } = renderHook(
        () => useChooserRowAvatar(localRow("other")),
        {
          wrapper: createWrapper(),
        },
      );
      await settle();
      expect(result.current).toEqual({ traits: null, imageUrl: null });
      expect(readAssistantAvatarHost).not.toHaveBeenCalled();
    });

    test.each([
      ["platform", platformRow("other")],
      [
        "paired",
        platformRow("other", { isPaired: true, isPlatformHosted: false }),
      ],
      ["docker", localRow("other", { cloud: "docker" })],
    ])("issues no host call for a %s row", async (_l, row) => {
      renderHook(() => useChooserRowAvatar(row), { wrapper: createWrapper() });
      await settle();
      expect(readAssistantAvatarHost).not.toHaveBeenCalled();
    });

    test("the connected local row still prefers the live path", async () => {
      readAssistantAvatarHost.mockResolvedValue({
        ok: true,
        avatar: { kind: "image", imageBase64: "cG5n" },
      });
      const { result } = renderHook(
        () => useChooserRowAvatar(localRow("active")),
        { wrapper: createWrapper() },
      );
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      await settle();
      expect(result.current.imageUrl).toBeNull();
      expect(readAssistantAvatarHost).not.toHaveBeenCalled();
    });

    test("the connected local row falls back to the host read when it is unreachable", async () => {
      fetchAvatarState.mockResolvedValue(null);
      const hostTraits = { ...traits, color: "sunset-orange" };
      readAssistantAvatarHost.mockResolvedValue({
        ok: true,
        avatar: { kind: "character", traits: hostTraits },
      });
      const { result } = renderHook(
        () => useChooserRowAvatar(localRow("active")),
        { wrapper: createWrapper() },
      );
      // The live read retries once (1s backoff) before it settles.
      await waitFor(
        () => {
          expect(result.current.traits).toEqual(hostTraits);
        },
        { timeout: 3000 },
      );
      expect(readAssistantAvatarHost).toHaveBeenCalledWith("active");
      expect(writeLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("invalidating the row prefix re-reads the host", async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      readAssistantAvatarHost.mockResolvedValue({
        ok: true,
        avatar: { kind: "character", traits },
      });
      const { result } = renderHook(
        () => useChooserRowAvatar(localRow("other")),
        {
          wrapper: createWrapper(queryClient),
        },
      );
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });

      const updated = { ...traits, color: "sunset-orange" };
      readAssistantAvatarHost.mockResolvedValue({
        ok: true,
        avatar: { kind: "character", traits: updated },
      });
      await queryClient.invalidateQueries({
        queryKey: chooserRowAvatarQueryKeyPrefix("other"),
      });
      await waitFor(() => {
        expect(result.current.traits).toEqual(updated);
      });
      expect(readAssistantAvatarHost).toHaveBeenCalledTimes(2);
    });
    test("a host read stays cached within the stale window", async () => {
      const wrapper = createWrapper();
      readAssistantAvatarHost.mockResolvedValue({
        ok: true,
        avatar: { kind: "character", traits },
      });
      const first = renderHook(() => useChooserRowAvatar(localRow("other")), {
        wrapper,
      });
      await waitFor(() => {
        expect(first.result.current.traits).toEqual(traits);
      });
      first.unmount();

      const second = renderHook(
        () => useChooserRowAvatar(localRow("other")),
        { wrapper },
      );
      await waitFor(() => {
        expect(second.result.current.traits).toEqual(traits);
      });
      await settle();
      expect(readAssistantAvatarHost).toHaveBeenCalledTimes(1);
    });

    test("a mounted row polls the host at the stale cadence in the foreground", async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      readAssistantAvatarHost.mockResolvedValue({
        ok: true,
        avatar: { kind: "character", traits },
      });
      const { result } = renderHook(
        () => useChooserRowAvatar(localRow("other")),
        { wrapper: createWrapper(queryClient) },
      );
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });

      // bun:test has no fake timers to fire React Query's interval, so pin
      // the polling contract on the live query instead of a remount.
      const hostQuery = queryClient
        .getQueryCache()
        .find({ queryKey: [...chooserRowAvatarQueryKeyPrefix("other"), "host"] });
      const observerOptions = hostQuery?.observers[0]?.options;
      expect(observerOptions?.refetchInterval).toBe(60_000);
      expect(observerOptions?.refetchIntervalInBackground).toBe(false);
      expect(hostQuery?.getObserversCount()).toBe(1);
    });

    test("a host read goes stale so a later mount re-reads the disk", async () => {
      const wrapper = createWrapper();
      readAssistantAvatarHost.mockResolvedValue({
        ok: true,
        avatar: { kind: "character", traits },
      });
      const first = renderHook(() => useChooserRowAvatar(localRow("other")), {
        wrapper,
      });
      await waitFor(() => {
        expect(first.result.current.traits).toEqual(traits);
      });
      first.unmount();

      setSystemTime(new Date(Date.now() + A_MINUTE_LATER));
      const updated = { ...traits, color: "sunset-orange" };
      readAssistantAvatarHost.mockResolvedValue({
        ok: true,
        avatar: { kind: "character", traits: updated },
      });
      const second = renderHook(
        () => useChooserRowAvatar(localRow("other")),
        { wrapper },
      );
      await waitFor(() => {
        expect(second.result.current.traits).toEqual(updated);
      });
      expect(readAssistantAvatarHost).toHaveBeenCalledTimes(2);
    });
  });

  describe("forgetAssistantAvatar", () => {
    test("revokes the live and cached object urls held for a removed assistant", async () => {
      fetchAvatarState.mockResolvedValue(imageState);
      fetchAvatarImageUrlResult.mockResolvedValue(found("blob:row-image"));
      const live = renderHook(() => useChooserRowAvatar(platformRow("other")), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(live.result.current.imageUrl).toBe("blob:row-image");
      });
      readLastSeenAvatar.mockResolvedValue({
        kind: "image",
        blob: new Blob(["png"]),
      });
      const cached = renderHook(() => useChooserRowAvatar(localRow("other")), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(cached.result.current.imageUrl).toBe("blob:cached-image");
      });

      forgetAssistantAvatar(new QueryClient(), "other");

      expect(revokeObjectURL).toHaveBeenCalledWith("blob:row-image");
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:cached-image");
    });

    test("drops the query entries that held the revoked urls", async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      queryClient.setQueryData(
        [...chooserRowAvatarQueryKeyPrefix("other"), "supported"],
        { traits: null, imageUrl: "blob:row-image", conclusive: true },
      );
      queryClient.setQueryData(chooserRowAvatarCacheQueryKey("other"), {
        traits: null,
        imageUrl: "blob:cached-image",
      });
      queryClient.setQueryData([...avatarQueryKey("other"), true], {
        components: null,
        traits: null,
        customImageUrl: "blob:live-image",
      });
      queryClient.setQueryData(chooserRowAvatarCacheQueryKey("kept"), {
        traits,
        imageUrl: null,
      });

      forgetAssistantAvatar(queryClient, "other");

      expect(
        queryClient.getQueryData([
          ...chooserRowAvatarQueryKeyPrefix("other"),
          "supported",
        ]),
      ).toBeUndefined();
      expect(
        queryClient.getQueryData(chooserRowAvatarCacheQueryKey("other")),
      ).toBeUndefined();
      expect(
        queryClient.getQueryData([...avatarQueryKey("other"), true]),
      ).toBeUndefined();
      expect(
        queryClient.getQueryData(chooserRowAvatarCacheQueryKey("kept")),
      ).toBeDefined();
    });

    test("an in-flight row fetch that resolves afterwards drops its blob and writes nothing", async () => {
      let resolveImage: (result: FileResult<string>) => void = () => {};
      fetchAvatarImageUrlResult.mockImplementationOnce(
        () =>
          new Promise<FileResult<string>>((resolve) => {
            resolveImage = resolve;
          }),
      );
      fetchAvatarState.mockResolvedValue(imageState);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      renderHook(() => useChooserRowAvatar(platformRow("other")), {
        wrapper: createWrapper(queryClient),
      });
      await waitFor(() => {
        expect(fetchAvatarImageUrlResult).toHaveBeenCalledTimes(1);
      });

      forgetAssistantAvatar(queryClient, "other");
      resolveImage(found("blob:late"));
      await waitFor(() => {
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:late");
      });
      await settle();
      expect(writeLastSeenAvatar).not.toHaveBeenCalled();

      // Nothing was registered for the late blob: a second release has nothing to revoke.
      revokeObjectURL.mockClear();
      forgetAssistantAvatar(queryClient, "other");
      expect(revokeObjectURL).not.toHaveBeenCalled();
    });
  });

  describe("last-seen cache", () => {
    test("writes a character entry after a live platform-proxy resolution", async () => {
      const { result } = renderHook(
        () => useChooserRowAvatar(platformRow("other")),
        { wrapper: createWrapper() },
      );
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      await waitFor(() => {
        expect(writeLastSeenAvatar).toHaveBeenCalledWith(
          "other",
          { kind: "character", traits },
          expect.any(Number),
        );
      });
      expect(deleteLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("writes an image entry as a Blob read back from the live blob url", async () => {
      const blob = new Blob(["png"], { type: "image/png" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(
        async () => new Response(blob),
      ) as unknown as typeof fetch;
      try {
        fetchAvatarState.mockResolvedValue(imageState);
        fetchAvatarImageUrlResult.mockResolvedValue(found("blob:row-image"));
        renderHook(() => useChooserRowAvatar(platformRow("other")), {
          wrapper: createWrapper(),
        });
        await waitFor(() => {
          expect(writeLastSeenAvatar).toHaveBeenCalledTimes(1);
        });
        expect(globalThis.fetch).toHaveBeenCalledWith("blob:row-image");
        const [id, entry] = writeLastSeenAvatar.mock.calls[0]!;
        expect(id).toBe("other");
        expect(entry.kind).toBe("image");
        expect(entry.kind === "image" && (await entry.blob.text())).toBe("png");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("writes the connected row's live avatar", async () => {
      renderHook(() => useChooserRowAvatar(platformRow("active")), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(writeLastSeenAvatar).toHaveBeenCalledWith(
          "active",
          { kind: "character", traits },
          expect.any(Number),
        );
      });
    });

    test("deletes the entry when a live source resolves kind none", async () => {
      fetchAvatarState.mockResolvedValue(noneState);
      const { result } = renderHook(
        () => useChooserRowAvatar(platformRow("other")),
        { wrapper: createWrapper() },
      );
      await waitFor(() => {
        expect(deleteLastSeenAvatar).toHaveBeenCalledWith(
          "other",
          expect.any(Number),
        );
      });
      expect(writeLastSeenAvatar).not.toHaveBeenCalled();
      expect(result.current).toEqual({ traits: null, imageUrl: null });
    });

    test("an unreachable legacy row keeps its cached avatar and does not evict it", async () => {
      fetchAvatarImageUrlResult.mockResolvedValue(FAILED);
      fetchCharacterTraitsResult.mockResolvedValue(FAILED);
      readLastSeenAvatar.mockResolvedValue({ kind: "character", traits });
      const { result } = renderHook(
        () =>
          useChooserRowAvatar(
            platformRow("other", { runtimeVersion: "0.8.6" }),
          ),
        { wrapper: createWrapper() },
      );
      await waitFor(() => {
        expect(fetchAvatarImageUrlResult).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      await settle();
      expect(result.current.traits).toEqual(traits);
      expect(deleteLastSeenAvatar).not.toHaveBeenCalled();
      expect(writeLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("a legacy row whose sidecars are both absent keeps its cached avatar (the proxy 404s for an asleep sibling)", async () => {
      readLastSeenAvatar.mockResolvedValue({ kind: "character", traits });
      const { result } = renderHook(
        () =>
          useChooserRowAvatar(
            platformRow("other", { runtimeVersion: "0.8.6" }),
          ),
        { wrapper: createWrapper() },
      );
      await waitFor(() => {
        expect(fetchCharacterTraitsResult).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      await settle();
      expect(deleteLastSeenAvatar).not.toHaveBeenCalled();
      expect(writeLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("a manifest image whose content fails keeps the cached image and does not evict it", async () => {
      fetchAvatarState.mockResolvedValue(imageState);
      fetchAvatarImageUrlResult.mockResolvedValue(FAILED);
      readLastSeenAvatar.mockResolvedValue({
        kind: "image",
        blob: new Blob(["png"]),
      });
      const { result } = renderHook(
        () => useChooserRowAvatar(platformRow("other")),
        { wrapper: createWrapper() },
      );
      await waitFor(() => {
        expect(result.current.imageUrl).toBe("blob:cached-image");
      });
      // The hook retries once before settling on the error.
      await waitFor(() => {
        expect(fetchAvatarImageUrlResult).toHaveBeenCalledTimes(2);
      });
      await settle();
      expect(result.current.imageUrl).toBe("blob:cached-image");
      expect(deleteLastSeenAvatar).not.toHaveBeenCalled();
      expect(writeLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("the connected row keeps its cached image when the manifest image content fails", async () => {
      fetchAvatarState.mockResolvedValue(imageState);
      fetchAvatarImageUrlResult.mockResolvedValue(FAILED);
      readLastSeenAvatar.mockResolvedValue({
        kind: "image",
        blob: new Blob(["png"]),
      });
      const { result } = renderHook(
        () => useChooserRowAvatar(platformRow("active")),
        { wrapper: createWrapper() },
      );
      await waitFor(() => {
        expect(result.current.imageUrl).toBe("blob:cached-image");
      });
      await settle();
      expect(deleteLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("an unreachable version-unknown row keeps its cached avatar", async () => {
      fetchAvatarState.mockResolvedValue(null);
      fetchAvatarImageUrlResult.mockResolvedValue(FAILED);
      fetchCharacterTraitsResult.mockResolvedValue(FAILED);
      readLastSeenAvatar.mockResolvedValue({ kind: "character", traits });
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
        expect(result.current.traits).toEqual(traits);
      });
      await settle();
      expect(deleteLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("a version-unknown row whose probe failed keeps its cached avatar on a double 404", async () => {
      fetchAvatarState.mockResolvedValue(null);
      readLastSeenAvatar.mockResolvedValue({ kind: "character", traits });
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
        expect(fetchCharacterTraitsResult).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      await settle();
      expect(deleteLastSeenAvatar).not.toHaveBeenCalled();
      expect(writeLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("a version-unknown row whose probe failed still trusts a populated sidecar", async () => {
      fetchAvatarState.mockResolvedValue(null);
      fetchCharacterTraitsResult.mockResolvedValue(found(traits));
      renderHook(
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
        expect(writeLastSeenAvatar).toHaveBeenCalledWith(
          "other",
          { kind: "character", traits },
          expect.any(Number),
        );
      });
    });

    test("a populated legacy read still writes the cache", async () => {
      fetchCharacterTraitsResult.mockResolvedValue(found(traits));
      renderHook(
        () =>
          useChooserRowAvatar(
            platformRow("other", { runtimeVersion: "0.8.6" }),
          ),
        { wrapper: createWrapper() },
      );
      await waitFor(() => {
        expect(writeLastSeenAvatar).toHaveBeenCalledWith(
          "other",
          { kind: "character", traits },
          expect.any(Number),
        );
      });
    });

    test("an image write that resolves after a newer traits write commits nothing", async () => {
      let resolveBlob: (r: Response) => void = () => {};
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(
        () => new Promise<Response>((resolve) => (resolveBlob = resolve)),
      ) as unknown as typeof fetch;
      try {
        fetchAvatarState.mockResolvedValue(imageState);
        fetchAvatarImageUrlResult.mockResolvedValue(found("blob:row-image"));
        const queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false } },
        });
        const { result } = renderHook(
          () => useChooserRowAvatar(platformRow("other")),
          { wrapper: createWrapper(queryClient) },
        );
        await waitFor(() => {
          expect(globalThis.fetch).toHaveBeenCalledWith("blob:row-image");
        });

        fetchAvatarState.mockResolvedValue(characterState);
        await queryClient.invalidateQueries({
          queryKey: chooserRowAvatarQueryKeyPrefix("other"),
        });
        await waitFor(() => {
          expect(result.current.traits).toEqual(traits);
        });
        await waitFor(() => {
          expect(writeLastSeenAvatar).toHaveBeenCalledTimes(1);
        });
        expect(writeLastSeenAvatar.mock.calls[0]![1]).toEqual({
          kind: "character",
          traits,
        });

        resolveBlob(new Response(new Blob(["png"])));
        await settle();
        expect(writeLastSeenAvatar).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("reads the cache as the final fallback when no live source applies", async () => {
      localClient = true;
      readLastSeenAvatar.mockResolvedValue({ kind: "character", traits });
      const { result } = renderHook(
        () => useChooserRowAvatar(platformRow("other", { isPaired: true })),
        { wrapper: createWrapper() },
      );
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      expect(readLastSeenAvatar).toHaveBeenCalledWith("other");
      expect(sdkCallCount()).toBe(0);
    });

    test("a host-sourced avatar is never written to the cache", async () => {
      localClient = true;
      hostAvailable = true;
      readAssistantAvatarHost.mockResolvedValue({
        ok: true,
        avatar: { kind: "character", traits },
      });
      const { result } = renderHook(
        () => useChooserRowAvatar(localRow("other")),
        {
          wrapper: createWrapper(),
        },
      );
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      await settle();
      expect(writeLastSeenAvatar).not.toHaveBeenCalled();
      expect(deleteLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("re-creates an object url from a cached image Blob", async () => {
      localClient = true;
      readLastSeenAvatar.mockResolvedValue({
        kind: "image",
        blob: new Blob(["png"]),
      });
      const { result } = renderHook(
        () => useChooserRowAvatar(platformRow("other", { isPaired: true })),
        { wrapper: createWrapper() },
      );
      await waitFor(() => {
        expect(result.current.imageUrl).toBe("blob:cached-image");
      });
      expect(result.current.traits).toBeNull();
    });

    test("falls back to the cache when the live fetch fails", async () => {
      fetchAvatarState.mockRejectedValue(new Error("boom"));
      readLastSeenAvatar.mockResolvedValue({ kind: "character", traits });
      const { result } = renderHook(
        () => useChooserRowAvatar(platformRow("other")),
        { wrapper: createWrapper() },
      );
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      expect(fetchAvatarState).toHaveBeenCalledTimes(1);
    });

    test("falls back to the cache for an unreachable connected row", async () => {
      fetchAvatarState.mockRejectedValue(new Error("offline"));
      fetchCharacterComponents.mockRejectedValue(new Error("offline"));
      readLastSeenAvatar.mockResolvedValue({ kind: "character", traits });
      const { result } = renderHook(
        () => useChooserRowAvatar(platformRow("active")),
        { wrapper: createWrapper() },
      );
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      expect(readLastSeenAvatar).toHaveBeenCalledWith("active");
    });

    test("never writes back data that came from the cache", async () => {
      localClient = true;
      readLastSeenAvatar.mockResolvedValue({ kind: "character", traits });
      const { result } = renderHook(
        () => useChooserRowAvatar(platformRow("other", { isPaired: true })),
        { wrapper: createWrapper() },
      );
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      await settle();
      expect(writeLastSeenAvatar).not.toHaveBeenCalled();
      expect(deleteLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("a cache read failure resolves to nulls", async () => {
      localClient = true;
      readLastSeenAvatar.mockRejectedValue(new Error("idb"));
      const { result } = renderHook(
        () => useChooserRowAvatar(platformRow("other", { isPaired: true })),
        { wrapper: createWrapper() },
      );
      await waitFor(() => {
        expect(readLastSeenAvatar).toHaveBeenCalledTimes(1);
      });
      await settle();
      expect(result.current).toEqual({ traits: null, imageUrl: null });
    });
  });
});
