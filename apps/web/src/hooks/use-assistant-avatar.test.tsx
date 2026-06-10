import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import type {
  AvatarState,
  CharacterComponents,
  CharacterTraits,
} from "@/types/avatar";
import { avatarQueryKey } from "@/lib/sync/query-tags";
import { MIN_VERSION } from "@/lib/backwards-compat/avatar-state-manifest";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

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
};

const imageState: AvatarState = {
  kind: "image",
  traits: null,
  source: "upload",
  image: { updatedAt: "2024-01-01T00:00:00Z", etag: "def" },
};

const noneState: AvatarState = {
  kind: "none",
  traits: null,
  source: null,
  image: null,
};

const fetchCharacterComponents = mock(async () => components);
const fetchAvatarState = mock(async () => noneState as AvatarState | null);
const fetchAvatarImageUrl = mock(async () => null as string | null);
const fetchCharacterTraits = mock(async () => null as CharacterTraits | null);

mock.module("@/assistant/avatar-api", () => ({
  fetchCharacterComponents,
  fetchAvatarState,
  fetchAvatarImageUrl,
  fetchCharacterTraits,
}));

const { useAssistantAvatar } = await import("@/hooks/use-assistant-avatar");

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  // Default to a manifest-capable assistant so the `/avatar/state` path is
  // exercised; legacy-path tests override the version explicitly.
  useAssistantIdentityStore.getState().setIdentity("test-asst", MIN_VERSION);
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
  fetchCharacterComponents.mockClear();
  fetchAvatarState.mockClear();
  fetchAvatarImageUrl.mockClear();
  fetchCharacterTraits.mockClear();
  fetchCharacterComponents.mockResolvedValue(components);
  fetchAvatarState.mockResolvedValue(noneState);
  fetchAvatarImageUrl.mockResolvedValue(null);
  fetchCharacterTraits.mockResolvedValue(null);
});

describe("useAssistantAvatar", () => {
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
    expect(fetchCharacterComponents).toHaveBeenCalledTimes(1);
    expect(fetchAvatarState).toHaveBeenCalledTimes(1);
    expect(fetchAvatarImageUrl).not.toHaveBeenCalled();
  });

  test("image kind fetches the static image and leaves traits null", async () => {
    fetchAvatarState.mockResolvedValueOnce(imageState);
    fetchAvatarImageUrl.mockResolvedValueOnce("blob:avatar-image");

    const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.customImageUrl).toBe("blob:avatar-image");
    });

    // image present + no traits ⇒ ChatAvatar renders the static circle.
    expect(result.current.components).toEqual(components);
    expect(result.current.traits).toBeNull();
    expect(fetchCharacterComponents).toHaveBeenCalledTimes(1);
    expect(fetchAvatarState).toHaveBeenCalledTimes(1);
    expect(fetchAvatarImageUrl).toHaveBeenCalledTimes(1);
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
    expect(fetchCharacterComponents).toHaveBeenCalledTimes(1);
    expect(fetchAvatarState).toHaveBeenCalledTimes(1);
    expect(fetchAvatarImageUrl).not.toHaveBeenCalled();
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
    fetchCharacterComponents.mockResolvedValueOnce(null as unknown as CharacterComponents);
    // AND components succeed on the retry
    fetchCharacterComponents.mockResolvedValueOnce(components);

    // WHEN the hook mounts with retry enabled
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: 1, retryDelay: 0 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useAssistantAvatar("asst-1"), { wrapper });

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
    fetchCharacterComponents.mockResolvedValue(null as unknown as CharacterComponents);
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

  test("pre-manifest assistants infer character traits from the sidecar files", async () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.8.6");
    fetchCharacterTraits.mockResolvedValueOnce(traits);

    const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.traits).toEqual(traits);
    });

    // Legacy path: no image ⇒ read traits sidecar, never touch `/avatar/state`.
    expect(result.current.customImageUrl).toBeNull();
    expect(fetchAvatarImageUrl).toHaveBeenCalledTimes(1);
    expect(fetchCharacterTraits).toHaveBeenCalledTimes(1);
    expect(fetchAvatarState).not.toHaveBeenCalled();
  });

  test("pre-manifest assistants render a custom image and skip the traits fetch", async () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.8.6");
    fetchAvatarImageUrl.mockResolvedValueOnce("blob:legacy-image");

    const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.customImageUrl).toBe("blob:legacy-image");
    });

    // A custom image exists ⇒ traits are intentionally not fetched.
    expect(result.current.traits).toBeNull();
    expect(fetchCharacterTraits).not.toHaveBeenCalled();
    expect(fetchAvatarState).not.toHaveBeenCalled();
  });
});
