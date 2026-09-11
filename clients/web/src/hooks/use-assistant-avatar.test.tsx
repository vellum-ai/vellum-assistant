import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import type { AvatarFileResult } from "@/assistant/avatar-api";
import type * as AvatarLastSeenCache from "@/lib/avatar-last-seen-cache";
import type {
  AvatarState,
  CharacterComponents,
  CharacterTraits,
} from "@/types/avatar";
import {
  avatarQueryKey,
  resolveAssistantAvatarOwnerScopeId,
  resolveAssistantNotificationPlatformId,
  shouldRetainAvatarPlaceholder,
  type AvatarData,
} from "@/hooks/use-assistant-avatar";
import { MIN_VERSION } from "@/lib/backwards-compat/avatar-state-manifest";
import { chooserRowAvatarCacheQueryKey } from "@/lib/persist-last-seen-avatar";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import {
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";

const components: CharacterComponents = {
  bodyShapes: [
    {
      id: "brontosaurus",
      viewBox: { width: 128, height: 256 },
      faceCenter: { x: 64, y: 80 },
      svgPath: "M 64 128 C 80 144 96 160 64 176 C 32 160 48 144 64 128 Z",
    },
  ],
  eyeStyles: [
    {
      id: "curious",
      sourceViewBox: { width: 32, height: 32 },
      eyeCenter: { x: 16, y: 16 },
      paths: [{ svgPath: "M 8 16 A 8 8 0 0 1 24 16", color: "#000" }],
    },
  ],
  colors: [{ id: "cosmic-purple", hex: "#7c3aed" }],
  faceCenterOverrides: [],
};

const traits: CharacterTraits = {
  bodyShape: "brontosaurus",
  eyeStyle: "curious",
  color: "cosmic-purple",
};

const characterState: AvatarState = {
  kind: "character",
  traits,
  source: "builder",
  image: { updatedAt: "2024-01-01T00:00:00Z", etag: "abc" },
  accent: null,
};

const imageState: AvatarState = {
  kind: "image",
  traits: null,
  source: "upload",
  image: { updatedAt: "2024-01-01T00:00:00Z", etag: "def" },
  accent: null,
};

const noneState: AvatarState = {
  kind: "none",
  traits: null,
  source: null,
  image: null,
  accent: null,
};

const fetchCharacterComponents = mock(async () => components);
const fetchAvatarState = mock(async () => noneState as AvatarState | null);
const ABSENT: AvatarFileResult<never> = { status: "absent" };
const FAILED: AvatarFileResult<never> = { status: "failed" };
const found = <T,>(value: T): AvatarFileResult<T> => ({
  status: "found",
  value,
});
const fetchAvatarImageUrlResult = mock(
  async (_assistantId: string) => ABSENT as AvatarFileResult<string>,
);
const fetchCharacterTraitsResult = mock(
  async () => ABSENT as AvatarFileResult<CharacterTraits>,
);

mock.module("@/assistant/avatar-api", () => ({
  fetchCharacterComponents,
  fetchAvatarState,
  fetchAvatarImageUrlResult,
  fetchCharacterTraitsResult,
}));

const actualLastSeenCache = await import("@/lib/avatar-last-seen-cache");
const writeLastSeenAvatar = mock(
  async (_id: string, _v: AvatarLastSeenCache.LastSeenAvatar) => {},
);
const deleteLastSeenAvatar = mock(async (_id: string) => {});
mock.module(
  "@/lib/avatar-last-seen-cache",
  (): Partial<typeof AvatarLastSeenCache> => ({
    ...actualLastSeenCache,
    writeLastSeenAvatar,
    deleteLastSeenAvatar,
  }),
);

const { releaseAssistantAvatarUrl, useAssistantAvatar } =
  await import("@/hooks/use-assistant-avatar");

const revokeObjectURL = mock((_url: string) => {});
URL.revokeObjectURL = revokeObjectURL;

const assistantOne: ResolvedAssistant = {
  id: "asst-1",
  isLocal: true,
  isPlatformHosted: false,
  isPaired: false,
  runtimeUrl: "https://first.example.com/runtime",
};

const assistantTwo: ResolvedAssistant = {
  ...assistantOne,
  id: "asst-2",
};

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

beforeEach(() => {
  // Default to a manifest-capable assistant so the `/avatar/state` path is
  // exercised; legacy-path tests override the version explicitly.
  useAssistantIdentityStore.getState().setIdentity("test-asst", MIN_VERSION);
  useResolvedAssistantsStore.setState({
    assistants: [assistantOne, assistantTwo],
    assistantsHydrated: true,
    activeAssistantId: "asst-1",
  });
});

afterEach(() => {
  cleanup();
  releaseAssistantAvatarUrl("asst-1");
  releaseAssistantAvatarUrl("asst-2");
  useAssistantIdentityStore.getState().clearIdentity();
  useResolvedAssistantsStore.setState({
    assistants: [],
    assistantsHydrated: false,
    activeAssistantId: null,
  });
  fetchCharacterComponents.mockClear();
  fetchAvatarState.mockClear();
  fetchAvatarImageUrlResult.mockClear();
  fetchCharacterTraitsResult.mockClear();
  writeLastSeenAvatar.mockClear();
  deleteLastSeenAvatar.mockClear();
  revokeObjectURL.mockClear();
  fetchCharacterComponents.mockResolvedValue(components);
  fetchAvatarState.mockResolvedValue(noneState);
  fetchAvatarImageUrlResult.mockResolvedValue(ABSENT);
  fetchCharacterTraitsResult.mockResolvedValue(ABSENT);
});

describe("useAssistantAvatar", () => {
  test("resolves only verified platform UUIDs for notification senders", () => {
    const platformId = "123e4567-e89b-12d3-a456-426614174000";
    expect(
      resolveAssistantNotificationPlatformId({
        ...assistantOne,
        platformAssistantId: platformId,
      }),
    ).toBe(platformId);
    expect(
      resolveAssistantNotificationPlatformId({
        ...assistantOne,
        id: platformId,
        isLocal: false,
        isPlatformHosted: true,
      }),
    ).toBe(platformId);
    expect(
      resolveAssistantNotificationPlatformId({
        ...assistantOne,
        platformAssistantId: "not-a-uuid",
      }),
    ).toBeNull();
  });

  test("does not fetch before an explicit notification owner resolves", async () => {
    const { result } = renderHook(
      () => useAssistantAvatar("asst-1", { ownerScopeId: null }),
      { wrapper: createWrapper() },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchAvatarState).not.toHaveBeenCalled();
    expect(result.current.owner).toBeUndefined();
  });

  test("retains the previous avatar while the same assistant rekeys", async () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.8.6");
    fetchCharacterTraitsResult.mockResolvedValueOnce(found(traits));

    let resolveManifest: (state: AvatarState) => void = () => {};
    fetchAvatarState.mockImplementationOnce(
      () =>
        new Promise<AvatarState>((resolve) => {
          resolveManifest = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      (supportsManifest: boolean) =>
        useAssistantAvatar("asst-1", { supportsManifest }),
      { wrapper: createWrapper(), initialProps: false },
    );
    await waitFor(() => {
      expect(result.current.traits).toEqual(traits);
    });

    rerender(true);
    expect(result.current.traits).toEqual(traits);

    resolveManifest(noneState);
    await waitFor(() => {
      expect(result.current.state).toEqual(noneState);
    });
  });

  test("does not retain assistant A while assistant B loads", async () => {
    fetchAvatarState.mockResolvedValueOnce(characterState);
    let resolveSecond: (state: AvatarState) => void = () => {};
    fetchAvatarState.mockImplementationOnce(
      () =>
        new Promise<AvatarState>((resolve) => {
          resolveSecond = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      (assistantId: string) => useAssistantAvatar(assistantId),
      { wrapper: createWrapper(), initialProps: "asst-1" },
    );
    await waitFor(() => {
      expect(result.current.traits).toEqual(traits);
    });

    rerender("asst-2");
    expect(result.current.traits).toBeNull();
    expect(result.current.customImageUrl).toBeNull();

    resolveSecond(noneState);
    await waitFor(() => {
      expect(result.current.state).toEqual(noneState);
    });
  });

  test("does not retain the same local assistant ID across connection scopes", () => {
    expect(
      shouldRetainAvatarPlaceholder(
        { assistantId: "local-assistant", scopeKey: "connection:one" },
        { assistantId: "local-assistant", scopeKey: "connection:two" },
      ),
    ).toBe(false);
  });

  test("an origin change removes the old scoped query and refetches when switching back", async () => {
    fetchAvatarState.mockResolvedValue(imageState);
    fetchAvatarImageUrlResult
      .mockResolvedValueOnce(found("blob:first-origin"))
      .mockResolvedValueOnce(found("blob:second-origin"))
      .mockResolvedValueOnce(found("blob:first-origin-return"));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const firstScope = resolveAssistantAvatarOwnerScopeId(
      assistantOne,
      null,
      null,
      null,
    )!;
    const secondAssistant = {
      ...assistantOne,
      runtimeUrl: "https://second.example.com/runtime",
    };
    const secondScope = resolveAssistantAvatarOwnerScopeId(
      secondAssistant,
      null,
      null,
      null,
    )!;

    const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => {
      expect(result.current.customImageUrl).toBe("blob:first-origin");
    });
    expect(result.current.owner?.scopeId).toBe(firstScope);

    act(() => {
      useResolvedAssistantsStore.setState({
        assistants: [secondAssistant, assistantTwo],
      });
    });
    await waitFor(() => {
      expect(result.current.customImageUrl).toBe("blob:second-origin");
    });
    expect(result.current.owner?.scopeId).toBe(secondScope);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first-origin");
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: avatarQueryKey("asst-1") })
        .some((query) =>
          query.queryKey.some(
            (part) =>
              typeof part === "object" &&
              part !== null &&
              "ownerScopeId" in part &&
              (part as { ownerScopeId?: unknown }).ownerScopeId === firstScope,
          ),
        ),
    ).toBe(false);

    act(() => {
      useResolvedAssistantsStore.setState({
        assistants: [assistantOne, assistantTwo],
      });
    });
    await waitFor(() => {
      expect(result.current.customImageUrl).toBe("blob:first-origin-return");
    });
    expect(fetchAvatarState).toHaveBeenCalledTimes(3);
    expect(result.current.owner?.scopeId).toBe(firstScope);
  });

  test("Root-style and default callers share one fully scoped query", async () => {
    fetchAvatarState.mockResolvedValue(characterState);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const scopeId = resolveAssistantAvatarOwnerScopeId(
      assistantOne,
      null,
      null,
      null,
    )!;

    const { result } = renderHook(
      () => ({
        root: useAssistantAvatar("asst-1", { ownerScopeId: scopeId }),
        display: useAssistantAvatar("asst-1"),
      }),
      { wrapper: createWrapper(queryClient) },
    );
    await waitFor(() => {
      expect(result.current.root.traits).toEqual(traits);
      expect(result.current.display.traits).toEqual(traits);
    });
    expect(fetchAvatarState).toHaveBeenCalledTimes(1);
    expect(result.current.root.owner).toEqual(result.current.display.owner);
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: avatarQueryKey("asst-1") }),
    ).toHaveLength(1);
  });

  test("switching one consumer from A to B preserves another consumer's A avatar", async () => {
    fetchAvatarState.mockResolvedValue(imageState);
    const imageFetchCounts = new Map<string, number>();
    fetchAvatarImageUrlResult.mockImplementation(async (assistantId) => {
      const count = (imageFetchCounts.get(assistantId) ?? 0) + 1;
      imageFetchCounts.set(assistantId, count);
      return found(`blob:${assistantId}:${count}`);
    });
    const secondOwner = {
      ...assistantTwo,
      runtimeUrl: "https://second.example.com/runtime",
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result, rerender } = renderHook(
      ({ dynamicId }: { dynamicId: "asst-1" | "asst-2" }) => ({
        stable: useAssistantAvatar("asst-1", {
          ownerAssistant: assistantOne,
        }),
        dynamic: useAssistantAvatar(dynamicId, {
          ownerAssistant: dynamicId === "asst-1" ? assistantOne : secondOwner,
        }),
      }),
      {
        wrapper: createWrapper(queryClient),
        initialProps: { dynamicId: "asst-1" },
      },
    );
    await waitFor(() => {
      expect(result.current.stable.customImageUrl).toBe("blob:asst-1:1");
      expect(result.current.dynamic.customImageUrl).toBe("blob:asst-1:1");
    });

    rerender({ dynamicId: "asst-2" });
    await waitFor(() => {
      expect(result.current.dynamic.customImageUrl).toBe("blob:asst-2:1");
    });
    expect(result.current.stable.customImageUrl).toBe("blob:asst-1:1");
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:asst-1:1");
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: avatarQueryKey("asst-1") }),
    ).toHaveLength(1);
  });

  test("disconnecting one consumer preserves another consumer's shared avatar", async () => {
    fetchAvatarState.mockResolvedValue(imageState);
    fetchAvatarImageUrlResult.mockResolvedValue(found("blob:shared-a"));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result, rerender } = renderHook(
      ({ connected }: { connected: boolean }) => ({
        stable: useAssistantAvatar("asst-1", {
          ownerAssistant: assistantOne,
        }),
        dynamic: useAssistantAvatar(connected ? "asst-1" : null, {
          ownerAssistant: connected ? assistantOne : null,
        }),
      }),
      {
        wrapper: createWrapper(queryClient),
        initialProps: { connected: true },
      },
    );
    await waitFor(() => {
      expect(result.current.stable.customImageUrl).toBe("blob:shared-a");
      expect(result.current.dynamic.customImageUrl).toBe("blob:shared-a");
    });

    rerender({ connected: false });
    expect(result.current.dynamic.customImageUrl).toBeNull();
    expect(result.current.stable.customImageUrl).toBe("blob:shared-a");
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:shared-a");
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: avatarQueryKey("asst-1") }),
    ).toHaveLength(1);
  });

  test("different assistants keep independent connection-scoped queries", async () => {
    fetchAvatarState.mockResolvedValue(imageState);
    const imageFetchCounts = new Map<string, number>();
    fetchAvatarImageUrlResult.mockImplementation(async (assistantId) => {
      const count = (imageFetchCounts.get(assistantId) ?? 0) + 1;
      imageFetchCounts.set(assistantId, count);
      return found(`blob:${assistantId}:${count}`);
    });
    const secondOwner = {
      ...assistantTwo,
      runtimeUrl: "https://other-assistant.example.com/runtime",
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result, rerender } = renderHook(
      ({ firstOwner }: { firstOwner: ResolvedAssistant }) => ({
        first: useAssistantAvatar("asst-1", { ownerAssistant: firstOwner }),
        second: useAssistantAvatar("asst-2", { ownerAssistant: secondOwner }),
      }),
      {
        wrapper: createWrapper(queryClient),
        initialProps: { firstOwner: assistantOne },
      },
    );
    await waitFor(() => {
      expect(result.current.first.customImageUrl).toBe("blob:asst-1:1");
      expect(result.current.second.customImageUrl).toBe("blob:asst-2:1");
    });

    rerender({
      firstOwner: {
        ...assistantOne,
        runtimeUrl: "https://first-moved.example.com/runtime",
      },
    });
    await waitFor(() => {
      expect(result.current.first.customImageUrl).toBe("blob:asst-1:2");
    });
    expect(result.current.second.customImageUrl).toBe("blob:asst-2:1");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:asst-1:1");
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:asst-2:1");
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: avatarQueryKey("asst-2") }),
    ).toHaveLength(1);
  });

  test("an exact legacy seed stays ownerless while the scoped query fetches", async () => {
    let resolveState: (state: AvatarState) => void = () => {};
    fetchAvatarState.mockImplementationOnce(
      () =>
        new Promise<AvatarState>((resolve) => {
          resolveState = resolve;
        }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData([...avatarQueryKey("asst-1"), true], {
      components,
      traits,
      customImageUrl: null,
      state: characterState,
    } satisfies AvatarData);
    const scopeId = resolveAssistantAvatarOwnerScopeId(
      assistantOne,
      null,
      null,
      null,
    )!;

    const { result } = renderHook(
      () => useAssistantAvatar("asst-1", { ownerScopeId: scopeId }),
      { wrapper: createWrapper(queryClient) },
    );
    expect(result.current.traits).toEqual(traits);
    expect(result.current.owner).toBeUndefined();
    await waitFor(() => {
      expect(fetchAvatarState).toHaveBeenCalledTimes(1);
    });

    resolveState(noneState);
    await waitFor(() => {
      expect(result.current.owner).toEqual({
        scopeId,
        assistantId: "asst-1",
      });
    });
  });

  test("a late result from assistant A cannot replace assistant B", async () => {
    let resolveFirst: (state: AvatarState) => void = () => {};
    fetchAvatarState.mockImplementationOnce(
      () =>
        new Promise<AvatarState>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    fetchAvatarState.mockResolvedValueOnce(imageState);
    fetchAvatarImageUrlResult.mockResolvedValueOnce(found("blob:assistant-b"));

    const { result, rerender } = renderHook(
      (assistantId: string) => useAssistantAvatar(assistantId),
      { wrapper: createWrapper(), initialProps: "asst-1" },
    );
    await waitFor(() => {
      expect(fetchAvatarState).toHaveBeenCalledTimes(1);
    });

    rerender("asst-2");
    await waitFor(() => {
      expect(result.current.customImageUrl).toBe("blob:assistant-b");
    });

    resolveFirst(characterState);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.customImageUrl).toBe("blob:assistant-b");
    expect(result.current.traits).toBeNull();
  });

  describe("last-seen cache", () => {
    test("a resolved character avatar is persisted for the chooser's fallback", async () => {
      fetchAvatarState.mockResolvedValueOnce(characterState);
      const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      await waitFor(() => {
        expect(writeLastSeenAvatar).toHaveBeenCalledWith(
          "asst-1",
          { kind: "character", traits },
          expect.any(Number),
        );
      });
      expect(deleteLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("a resolved none evicts the entry", async () => {
      const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true);
      });
      await waitFor(() => {
        expect(deleteLastSeenAvatar).toHaveBeenCalledWith(
          "asst-1",
          expect.any(Number),
        );
      });
      expect(writeLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("a persist invalidates the chooser's cache query for that id", async () => {
      fetchAvatarState.mockResolvedValueOnce(characterState);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const cacheKey = chooserRowAvatarCacheQueryKey("asst-1");
      queryClient.setQueryData(cacheKey, { traits: null, imageUrl: null });
      renderHook(() => useAssistantAvatar("asst-1"), {
        wrapper: createWrapper(queryClient),
      });
      await waitFor(() => {
        expect(writeLastSeenAvatar).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(queryClient.getQueryState(cacheKey)?.isInvalidated).toBe(true);
      });
    });

    test("a sibling's read never touches the cache, only the active assistant's does", async () => {
      fetchAvatarState.mockResolvedValueOnce(characterState);
      const { result } = renderHook(() => useAssistantAvatar("asst-2"), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(writeLastSeenAvatar).not.toHaveBeenCalled();
      expect(deleteLastSeenAvatar).not.toHaveBeenCalled();
    });

    test("a read issued for the active assistant persists even if the user switched before it landed", async () => {
      let resolveState: (state: AvatarState) => void = () => {};
      fetchAvatarState.mockImplementationOnce(
        () =>
          new Promise<AvatarState>((resolve) => {
            resolveState = resolve;
          }),
      );
      const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(fetchAvatarState).toHaveBeenCalledTimes(1);
      });

      useResolvedAssistantsStore.getState().setActiveAssistantId("asst-2");
      resolveState(characterState);

      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      await waitFor(() => {
        expect(writeLastSeenAvatar).toHaveBeenCalledWith(
          "asst-1",
          { kind: "character", traits },
          expect.any(Number),
        );
      });
    });

    test("a superseded legacy read that finishes last persists nothing and drops its blob", async () => {
      let resolveOld: (result: AvatarFileResult<string>) => void = () => {};
      const oldImage = new Promise<AvatarFileResult<string>>((resolve) => {
        resolveOld = resolve;
      });
      fetchAvatarImageUrlResult.mockImplementationOnce(() => oldImage);
      fetchAvatarState.mockResolvedValue(characterState);

      const { result, rerender } = renderHook(
        (supportsManifest: boolean) =>
          useAssistantAvatar("asst-1", { supportsManifest }),
        { wrapper: createWrapper(), initialProps: false },
      );
      await waitFor(() => {
        expect(fetchAvatarImageUrlResult).toHaveBeenCalledTimes(1);
      });

      rerender(true);
      await waitFor(() => {
        expect(result.current.traits).toEqual(traits);
      });
      await waitFor(() => {
        expect(writeLastSeenAvatar).toHaveBeenCalledTimes(1);
      });

      resolveOld(found("blob:old"));
      await waitFor(() => {
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:old");
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(writeLastSeenAvatar).toHaveBeenCalledTimes(1);
      expect(writeLastSeenAvatar).toHaveBeenCalledWith(
        "asst-1",
        { kind: "character", traits },
        expect.any(Number),
      );
      expect(result.current.traits).toEqual(traits);
      expect(result.current.customImageUrl).toBeNull();
    });

    test("an inconclusive read touches nothing", async () => {
      fetchAvatarState.mockResolvedValue(null);
      const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(fetchAvatarState).toHaveBeenCalled();
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(result.current.isSuccess).toBe(false);
      expect(writeLastSeenAvatar).not.toHaveBeenCalled();
      expect(deleteLastSeenAvatar).not.toHaveBeenCalled();
    });
  });

  test("character kind exposes manifest traits and skips the image fetch", async () => {
    fetchAvatarState.mockResolvedValueOnce(characterState);

    const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.traits).toEqual(traits);
    });

    // traits present + no image ⇒ ChatAvatar renders AnimatedAvatar.
    expect(result.current.components).toEqual(components);
    expect(result.current.customImageUrl).toBeNull();
    // The manifest itself travels with the derived fields, for consumers that
    // need `kind` rather than just traits.
    expect(result.current.state).toEqual(characterState);
    expect(fetchCharacterComponents).toHaveBeenCalledTimes(1);
    expect(fetchAvatarState).toHaveBeenCalledTimes(1);
    expect(fetchAvatarImageUrlResult).not.toHaveBeenCalled();
  });

  test("image kind fetches the static image and leaves traits null", async () => {
    fetchAvatarState.mockResolvedValueOnce(imageState);
    fetchAvatarImageUrlResult.mockResolvedValueOnce(found("blob:avatar-image"));

    const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.customImageUrl).toBe("blob:avatar-image");
    });

    // image present + no traits ⇒ ChatAvatar renders the static circle.
    expect(result.current.components).toEqual(components);
    expect(result.current.traits).toBeNull();
    expect(result.current.state).toEqual(imageState);
    expect(fetchCharacterComponents).toHaveBeenCalledTimes(1);
    expect(fetchAvatarState).toHaveBeenCalledTimes(1);
    expect(fetchAvatarImageUrlResult).toHaveBeenCalledTimes(1);
  });

  test("none kind falls back with neither traits nor image", async () => {
    const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.components).toEqual(components);
    });

    // both null ⇒ ChatAvatar falls back to default components / "V".
    expect(result.current.traits).toBeNull();
    expect(result.current.customImageUrl).toBeNull();
    expect(result.current.state).toEqual(noneState);
    expect(fetchCharacterComponents).toHaveBeenCalledTimes(1);
    expect(fetchAvatarState).toHaveBeenCalledTimes(1);
    expect(fetchAvatarImageUrlResult).not.toHaveBeenCalled();
  });

  test("null state (transport failure) preserves the cached avatar instead of blanking", async () => {
    // First render: a real character avatar is fetched and cached.
    fetchAvatarState.mockResolvedValueOnce(characterState);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const first = renderHook(() => useAssistantAvatar("asst-1"), { wrapper });
    await waitFor(() => {
      expect(first.result.current.traits).toEqual(traits);
    });
    first.unmount();

    // Now the daemon goes away / version-skews: `/avatar/state` returns null.
    // Refetching must NOT blank the avatar — the queryFn throws so React
    // Query retains the previously cached data.
    fetchAvatarState.mockResolvedValue(null);
    await queryClient.invalidateQueries({ queryKey: avatarQueryKey("asst-1") });

    const second = renderHook(() => useAssistantAvatar("asst-1"), { wrapper });
    await waitFor(() => {
      expect(fetchAvatarState).toHaveBeenCalledTimes(2);
    });

    // Cached character avatar is preserved; it did not fall back to "V".
    expect(second.result.current.traits).toEqual(traits);
    expect(second.result.current.customImageUrl).toBeNull();
    second.unmount();
  });

  test("null components (transport failure) retries instead of caching a broken avatar", async () => {
    // GIVEN the avatar state endpoint succeeds with a character avatar
    fetchAvatarState.mockResolvedValue(characterState);
    // AND the character-components endpoint fails transiently
    fetchCharacterComponents.mockResolvedValueOnce(
      null as unknown as CharacterComponents,
    );
    // AND components succeed on the retry
    fetchCharacterComponents.mockResolvedValueOnce(components);

    // WHEN the hook mounts with retry enabled
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: 1, retryDelay: 0 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
      wrapper,
    });

    // THEN the query retries and resolves with the successful components
    await waitFor(() => {
      expect(result.current.components).toEqual(components);
    });

    // AND the character traits are preserved from the successful state fetch
    expect(result.current.traits).toEqual(traits);
    // AND components were fetched twice (initial failure + retry)
    expect(fetchCharacterComponents).toHaveBeenCalledTimes(2);
  });

  test("null components preserves cached avatar on refetch instead of blanking", async () => {
    // GIVEN a character avatar was previously fetched and cached
    fetchAvatarState.mockResolvedValue(characterState);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const first = renderHook(() => useAssistantAvatar("asst-1"), { wrapper });
    await waitFor(() => {
      expect(first.result.current.traits).toEqual(traits);
    });
    first.unmount();

    // WHEN the character-components endpoint fails on a subsequent refetch
    fetchCharacterComponents.mockResolvedValue(
      null as unknown as CharacterComponents,
    );
    await queryClient.invalidateQueries({ queryKey: avatarQueryKey("asst-1") });

    const second = renderHook(() => useAssistantAvatar("asst-1"), { wrapper });
    await waitFor(() => {
      expect(fetchCharacterComponents).toHaveBeenCalledTimes(2);
    });

    // THEN the cached character avatar is preserved (not blanked to "V")
    expect(second.result.current.traits).toEqual(traits);
    expect(second.result.current.components).toEqual(components);
    second.unmount();
  });

  test("image avatar renders successfully even when components fail", async () => {
    // GIVEN the avatar state is an uploaded image
    fetchAvatarState.mockResolvedValue(imageState);
    // AND the image fetch succeeds
    fetchAvatarImageUrlResult.mockResolvedValue(found("blob:avatar-image"));
    // AND the character-components endpoint fails
    fetchCharacterComponents.mockResolvedValue(
      null as unknown as CharacterComponents,
    );

    // WHEN the hook mounts
    const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
      wrapper: createWrapper(),
    });

    // THEN the custom image URL is returned (not thrown away)
    await waitFor(() => {
      expect(result.current.customImageUrl).toBe("blob:avatar-image");
    });

    // AND components is null but that's fine — ChatAvatar renders via <img>
    expect(result.current.components).toBeNull();
    expect(result.current.traits).toBeNull();
  });

  test("pre-manifest assistants infer character traits from the sidecar files", async () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.8.6");
    fetchCharacterTraitsResult.mockResolvedValueOnce(found(traits));

    const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.traits).toEqual(traits);
    });

    // Legacy path: no image ⇒ read traits sidecar, never touch `/avatar/state`.
    expect(result.current.customImageUrl).toBeNull();
    // The file precedence is restated as a manifest, with the two fields the
    // sidecars cannot answer left null.
    expect(result.current.state).toEqual({
      kind: "character",
      traits,
      source: null,
      image: null,
      accent: null,
    });
    expect(fetchAvatarImageUrlResult).toHaveBeenCalledTimes(1);
    expect(fetchCharacterTraitsResult).toHaveBeenCalledTimes(1);
    expect(fetchAvatarState).not.toHaveBeenCalled();
  });

  test("pre-manifest assistants render a custom image and skip the traits fetch", async () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.8.6");
    fetchAvatarImageUrlResult.mockResolvedValueOnce(found("blob:legacy-image"));

    const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.customImageUrl).toBe("blob:legacy-image");
    });

    // A custom image exists ⇒ traits are intentionally not fetched.
    expect(result.current.traits).toBeNull();
    expect(result.current.state).toEqual({
      kind: "image",
      traits: null,
      source: null,
      image: null,
      accent: null,
    });
    expect(fetchCharacterTraitsResult).not.toHaveBeenCalled();
    expect(fetchAvatarState).not.toHaveBeenCalled();
  });

  test("image content failure preserves the cached avatar instead of blanking", async () => {
    fetchAvatarState.mockResolvedValue(imageState);
    fetchAvatarImageUrlResult.mockResolvedValueOnce(found("blob:avatar-image"));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const first = renderHook(() => useAssistantAvatar("asst-1"), { wrapper });
    await waitFor(() => {
      expect(first.result.current.customImageUrl).toBe("blob:avatar-image");
    });
    first.unmount();

    // The manifest still says image, but the content request fails.
    fetchAvatarImageUrlResult.mockResolvedValue(FAILED);
    await queryClient.invalidateQueries({ queryKey: avatarQueryKey("asst-1") });

    const second = renderHook(() => useAssistantAvatar("asst-1"), { wrapper });
    await waitFor(() => {
      expect(fetchAvatarImageUrlResult).toHaveBeenCalledTimes(2);
    });
    expect(second.result.current.customImageUrl).toBe("blob:avatar-image");
  });

  test("pre-manifest assistants with both sidecars absent resolve to a bare avatar", async () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.8.6");

    const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.traits).toBeNull();
    expect(result.current.customImageUrl).toBeNull();
  });

  test("pre-manifest image read failure is inconclusive even when traits load", async () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.8.6");
    fetchAvatarImageUrlResult.mockResolvedValueOnce(found("blob:avatar-image"));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const first = renderHook(() => useAssistantAvatar("asst-1"), { wrapper });
    await waitFor(() => {
      expect(first.result.current.customImageUrl).toBe("blob:avatar-image");
    });
    first.unmount();

    fetchAvatarImageUrlResult.mockResolvedValue(FAILED);
    fetchCharacterTraitsResult.mockResolvedValue(found(traits));
    await queryClient.invalidateQueries({ queryKey: avatarQueryKey("asst-1") });

    const second = renderHook(() => useAssistantAvatar("asst-1"), { wrapper });
    await waitFor(() => {
      expect(fetchAvatarImageUrlResult).toHaveBeenCalledTimes(2);
    });
    expect(fetchCharacterTraitsResult).not.toHaveBeenCalled();
    expect(second.result.current.customImageUrl).toBe("blob:avatar-image");
    expect(second.result.current.traits).toBeNull();
  });

  test("pre-manifest sidecar transport failure preserves the cached avatar", async () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.8.6");
    fetchCharacterTraitsResult.mockResolvedValueOnce(found(traits));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const first = renderHook(() => useAssistantAvatar("asst-1"), { wrapper });
    await waitFor(() => {
      expect(first.result.current.traits).toEqual(traits);
    });
    first.unmount();

    fetchAvatarImageUrlResult.mockResolvedValue(FAILED);
    fetchCharacterTraitsResult.mockResolvedValue(FAILED);
    await queryClient.invalidateQueries({ queryKey: avatarQueryKey("asst-1") });

    const second = renderHook(() => useAssistantAvatar("asst-1"), { wrapper });
    await waitFor(() => {
      expect(fetchAvatarImageUrlResult).toHaveBeenCalledTimes(2);
    });
    expect(second.result.current.traits).toEqual(traits);
  });
});
