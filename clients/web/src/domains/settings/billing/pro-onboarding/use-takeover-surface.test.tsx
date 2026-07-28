/**
 * Tests for `useTakeoverSurface`. The avatar hook is mocked to serve a
 * per-test payload and to record the id it is queried with, so the
 * target-selection rule and the flash guard can both be asserted without a
 * fetch. The resolved-assistants store is driven through `setState`, as in
 * `provisioning-state.test.tsx`.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook } from "@testing-library/react";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { SURFACE_GROUND } from "@/utils/avatar-tone";

/** The id handed to the avatar hook, captured to assert the target rule. */
let avatarQueryId: string | null | undefined;
/** The payload the mocked avatar query resolves to, set per test. */
let avatar: {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  isLoading: boolean;
};
mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: (assistantId: string | null) => {
    avatarQueryId = assistantId;
    return { ...avatar, invalidate: () => {} };
  },
}));

const { useTakeoverSurface } = await import("./use-takeover-surface");

const GREEN_SURFACE = "#1d281d";
const PURPLE_SURFACE = "#29202e";

function traits(color: string): CharacterTraits {
  return { bodyShape: "blob", eyeStyle: "default", color };
}

beforeEach(() => {
  avatarQueryId = undefined;
  avatar = {
    components: null,
    traits: null,
    customImageUrl: null,
    isLoading: false,
  };
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

describe("target selection", () => {
  test("falls back to the active assistant when no id is passed", () => {
    useResolvedAssistantsStore.setState({
      activeAssistantId: "active-assistant",
    });
    avatar.components = BUNDLED_COMPONENTS;

    const { result } = renderHook(() => useTakeoverSurface());

    expect(avatarQueryId).toBe("active-assistant");
    expect(result.current.ready).toBe(true);
  });

  test("an explicit null does not fall back to the active assistant", () => {
    // The active assistant is deliberately non-null: with the store's default
    // null, an unresolved surface would pass for the wrong reason.
    useResolvedAssistantsStore.setState({
      activeAssistantId: "active-assistant",
    });
    avatar.components = BUNDLED_COMPONENTS;
    avatar.traits = traits("purple");

    const { result } = renderHook(() => useTakeoverSurface(null));

    expect(avatarQueryId).toBeNull();
    expect(result.current.ready).toBe(false);
    expect(result.current.tintHex).toBe(SURFACE_GROUND);
    expect(result.current.backdropImageUrl).toBeNull();
  });
});

describe("flash guard", () => {
  test("holds the neutral ground while the avatar query is in flight", () => {
    avatar = {
      components: BUNDLED_COMPONENTS,
      traits: traits("purple"),
      customImageUrl: "blob:avatar",
      isLoading: true,
    };

    const { result } = renderHook(() =>
      useTakeoverSurface("primary-assistant"),
    );

    expect(result.current.ready).toBe(false);
    expect(result.current.tintHex).toBe(SURFACE_GROUND);
    expect(result.current.backdropImageUrl).toBeNull();
  });
});

describe("avatar render inputs", () => {
  test("passes the query payload through for the ready branch to draw", () => {
    avatar.components = BUNDLED_COMPONENTS;
    avatar.traits = traits("purple");
    avatar.customImageUrl = "blob:custom-avatar";

    const { result } = renderHook(() =>
      useTakeoverSurface("primary-assistant"),
    );

    expect(result.current.ready).toBe(true);
    expect(result.current.avatar).toEqual({
      components: BUNDLED_COMPONENTS,
      traits: traits("purple"),
      customImageUrl: "blob:custom-avatar",
    });
  });
});

describe("resolved surfaces", () => {
  test("a character's trait color becomes the tint", () => {
    avatar.components = BUNDLED_COMPONENTS;
    avatar.traits = traits("purple");

    const { result } = renderHook(() =>
      useTakeoverSurface("primary-assistant"),
    );

    expect(result.current.tintHex.toLowerCase()).toBe(PURPLE_SURFACE);
    expect(result.current.backdropImageUrl).toBeNull();
    expect(result.current.ready).toBe(true);
  });

  test("a custom image becomes the backdrop and leaves the ground neutral", () => {
    avatar.components = BUNDLED_COMPONENTS;
    avatar.customImageUrl = "blob:custom-avatar";

    const { result } = renderHook(() =>
      useTakeoverSurface("primary-assistant"),
    );

    expect(result.current.backdropImageUrl).toBe("blob:custom-avatar");
    expect(result.current.tintHex).toBe(SURFACE_GROUND);
  });

  test("no traits and no image tints from the first bundled color", () => {
    // ChatAvatar draws that creature, so the surface has to match it.
    avatar.components = BUNDLED_COMPONENTS;

    const { result } = renderHook(() =>
      useTakeoverSurface("primary-assistant"),
    );

    expect(result.current.tintHex.toLowerCase()).toBe(GREEN_SURFACE);
    expect(result.current.backdropImageUrl).toBeNull();
  });

  test("a settled query with no components still tints from the bundled creature", () => {
    // The query settles (ready) with no data at all: components and traits null,
    // no image. ChatAvatar draws the bundled green creature from its own
    // fallback, so the surface tints green to match it rather than dropping to
    // the neutral ground.
    avatar = {
      components: null,
      traits: null,
      customImageUrl: null,
      isLoading: false,
    };

    const { result } = renderHook(() =>
      useTakeoverSurface("primary-assistant"),
    );

    expect(result.current.ready).toBe(true);
    expect(result.current.tintHex.toLowerCase()).toBe(GREEN_SURFACE);
    expect(result.current.backdropImageUrl).toBeNull();
  });
});
