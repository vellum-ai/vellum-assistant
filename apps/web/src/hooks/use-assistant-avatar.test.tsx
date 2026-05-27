import type { ReactNode } from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

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

const fetchCharacterComponents = mock(async () => components);
const fetchCharacterTraits = mock(async () => traits);
const fetchAvatarImageUrl = mock(async () => null as string | null);

mock.module("@/assistant/avatar-api", () => ({
  fetchCharacterComponents,
  fetchCharacterTraits,
  fetchAvatarImageUrl,
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

afterEach(() => {
  cleanup();
  fetchCharacterComponents.mockClear();
  fetchCharacterTraits.mockClear();
  fetchAvatarImageUrl.mockClear();
  fetchCharacterComponents.mockResolvedValue(components);
  fetchCharacterTraits.mockResolvedValue(traits);
  fetchAvatarImageUrl.mockResolvedValue(null);
});

describe("useAssistantAvatar", () => {
  test("skips character traits when a custom avatar image is available", async () => {
    fetchAvatarImageUrl.mockResolvedValueOnce("blob:avatar-image");

    const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.customImageUrl).toBe("blob:avatar-image");
    });

    expect(result.current.components).toEqual(components);
    expect(result.current.traits).toBeNull();
    expect(fetchCharacterComponents).toHaveBeenCalledTimes(1);
    expect(fetchAvatarImageUrl).toHaveBeenCalledTimes(1);
    expect(fetchCharacterTraits).not.toHaveBeenCalled();
  });

  test("fetches character traits when no avatar image is available", async () => {
    const { result } = renderHook(() => useAssistantAvatar("asst-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.traits).toEqual(traits);
    });

    expect(result.current.customImageUrl).toBeNull();
    expect(fetchCharacterComponents).toHaveBeenCalledTimes(1);
    expect(fetchAvatarImageUrl).toHaveBeenCalledTimes(1);
    expect(fetchCharacterTraits).toHaveBeenCalledTimes(1);
  });
});
