/**
 * Tests for `useTakeoverSurface`. The avatar hook is mocked to serve a
 * per-test payload and to record the id it is queried with, so the
 * target-selection rule and the flash guard can both be asserted without a
 * fetch. The resolved-assistants store is driven through `setState`, as in
 * `provisioning-state.test.tsx`.
 */
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { renderHook } from "@testing-library/react";

import * as assistantAvatarMod from "@/hooks/use-assistant-avatar";
import type { AvatarData } from "@/hooks/use-assistant-avatar";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { SURFACE_GROUND } from "@/utils/avatar-tone";

/** The id handed to the avatar hook, captured to assert the target rule. */
let avatarQueryId: string | null | undefined;
/** The payload the mocked avatar query resolves to, set per test. */
let avatar: AvatarData & { isLoading: boolean };
mock.module("@/hooks/use-assistant-avatar", () => ({
  ...assistantAvatarMod,
  useAssistantAvatar: (assistantId: string | null) => {
    avatarQueryId = assistantId;
    return { ...avatar, invalidate: () => {} };
  },
}));

const { useTakeoverSurface } = await import("./use-takeover-surface");
// Dynamic like the hook above: a static import is hoisted over `mock.module`,
// which would load the real avatar hook that the stash module imports.
const { clearTakeoverAvatarStash, saveTakeoverAvatarStash } = await import(
  "@/lib/billing/takeover-avatar-stash"
);

const GREEN_SURFACE = "#1d281d";
const PURPLE_SURFACE = "#29202e";
const ORANGE_SURFACE = "#332019";

function traits(color: string): CharacterTraits {
  return { bodyShape: "blob", eyeStyle: "curious", color };
}

function seedStash(assistantId: string, color: string): void {
  saveTakeoverAvatarStash({
    assistantId,
    components: BUNDLED_COMPONENTS,
    traits: traits(color),
  });
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
  clearTakeoverAvatarStash();
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

describe("avatar stash", () => {
  test("draws the stash while the live query is still in flight", () => {
    seedStash("primary-assistant", "purple");
    avatar.isLoading = true;

    const { result } = renderHook(() =>
      useTakeoverSurface("primary-assistant"),
    );

    expect(result.current.ready).toBe(true);
    expect(result.current.avatar).toEqual({
      components: BUNDLED_COMPONENTS,
      traits: traits("purple"),
      customImageUrl: null,
    });
    expect(result.current.tintHex.toLowerCase()).toBe(PURPLE_SURFACE);
    expect(result.current.backdropImageUrl).toBeNull();
  });

  test("an unnamed target draws the stash rather than withholding", () => {
    useResolvedAssistantsStore.setState({
      activeAssistantId: "active-assistant",
    });
    seedStash("primary-assistant", "purple");

    const { result } = renderHook(() => useTakeoverSurface(null));

    expect(avatarQueryId).toBeNull();
    expect(result.current.ready).toBe(true);
    expect(result.current.avatar.traits).toEqual(traits("purple"));
    expect(result.current.tintHex.toLowerCase()).toBe(PURPLE_SURFACE);
  });

  test("a stash that expires while the hook stays mounted stops drawing", () => {
    seedStash("primary-assistant", "purple");
    avatar.isLoading = true;

    const { result, rerender } = renderHook(() =>
      useTakeoverSurface("primary-assistant"),
    );
    expect(result.current.ready).toBe(true);

    // The memoized read outlives the TTL on a mounted native return, so the
    // per-render freshness check has to retire it without a version bump.
    const nowSpy = spyOn(Date, "now");
    nowSpy.mockReturnValue(Date.now() + 31 * 60 * 1000);
    try {
      rerender();
      expect(result.current.ready).toBe(false);
      expect(result.current.tintHex).toBe(SURFACE_GROUND);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("a stash for another assistant never draws", () => {
    seedStash("other-assistant", "purple");
    avatar.isLoading = true;

    const { result } = renderHook(() =>
      useTakeoverSurface("primary-assistant"),
    );

    expect(result.current.ready).toBe(false);
    expect(result.current.tintHex).toBe(SURFACE_GROUND);
    expect(result.current.avatar.components).toBeNull();
  });

  test("live data replaces the stash the moment it lands", () => {
    seedStash("primary-assistant", "purple");
    avatar.isLoading = true;

    const { rerender, result } = renderHook(() =>
      useTakeoverSurface("primary-assistant"),
    );
    expect(result.current.tintHex.toLowerCase()).toBe(PURPLE_SURFACE);

    avatar = {
      components: BUNDLED_COMPONENTS,
      traits: traits("orange"),
      customImageUrl: null,
      isLoading: false,
    };
    rerender();

    expect(result.current.avatar.traits).toEqual(traits("orange"));
    expect(result.current.tintHex.toLowerCase()).toBe(ORANGE_SURFACE);
  });

  test("picks up a stash written after the hook already mounted", () => {
    // The native return: checkout opens an external browser, so the billing
    // modal hosting this hook is mounted (and already read an empty stash)
    // before the redirect writes one.
    avatar.isLoading = true;

    const { rerender, result } = renderHook(() =>
      useTakeoverSurface("primary-assistant"),
    );
    expect(result.current.ready).toBe(false);
    expect(result.current.tintHex).toBe(SURFACE_GROUND);

    seedStash("primary-assistant", "purple");
    rerender();

    expect(result.current.ready).toBe(true);
    expect(result.current.avatar.traits).toEqual(traits("purple"));
    expect(result.current.tintHex.toLowerCase()).toBe(PURPLE_SURFACE);
  });

  test("a target resolving to another assistant mid-flight withholds the stash", () => {
    // A mismatch withholds whether it exists at mount or appears mid-flight:
    // drawing on is drawing the wrong creature at full-viewport scale.
    seedStash("primary-assistant", "purple");
    avatar.isLoading = true;

    const { rerender, result } = renderHook(
      ({ id }: { id?: string | null }) => useTakeoverSurface(id),
      { initialProps: { id: null } as { id?: string | null } },
    );
    expect(result.current.ready).toBe(true);
    expect(result.current.avatar.traits).toEqual(traits("purple"));

    rerender({ id: "other-assistant" });

    expect(result.current.ready).toBe(false);
    expect(result.current.tintHex).toBe(SURFACE_GROUND);

    avatar = {
      components: BUNDLED_COMPONENTS,
      traits: traits("orange"),
      customImageUrl: null,
      isLoading: false,
    };
    rerender({ id: "other-assistant" });

    expect(result.current.ready).toBe(true);
    expect(result.current.avatar.traits).toEqual(traits("orange"));
    expect(result.current.tintHex.toLowerCase()).toBe(ORANGE_SURFACE);
  });

  test("a settle with no data at all keeps the stash", () => {
    // The daemon erroring while the machine restarts settles the query empty.
    // The stashed creature beats falling through to the bundled green one.
    seedStash("primary-assistant", "purple");

    const { result } = renderHook(() =>
      useTakeoverSurface("primary-assistant"),
    );

    expect(result.current.ready).toBe(true);
    expect(result.current.avatar.traits).toEqual(traits("purple"));
    expect(result.current.tintHex.toLowerCase()).toBe(PURPLE_SURFACE);
  });
});
