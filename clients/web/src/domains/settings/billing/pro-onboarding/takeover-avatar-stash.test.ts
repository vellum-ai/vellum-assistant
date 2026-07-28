import { beforeEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

import {
  captureTakeoverAvatarStash,
  clearTakeoverAvatarStash,
  readTakeoverAvatarStash,
  saveTakeoverAvatarStash,
} from "./takeover-avatar-stash";

const STORAGE_KEY = "vellum.pro-takeover-avatar";

const TRAITS: CharacterTraits = {
  bodyShape: "blob",
  eyeStyle: "default",
  color: "purple",
};

beforeEach(() => {
  sessionStorage.clear();
  // Reset the module-level in-memory mirror so it can't leak across tests.
  clearTakeoverAvatarStash();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

describe("saveTakeoverAvatarStash / readTakeoverAvatarStash", () => {
  test("round-trips the payload and stamps savedAt", () => {
    const before = Date.now();
    saveTakeoverAvatarStash({
      assistantId: "a1",
      components: BUNDLED_COMPONENTS,
      traits: TRAITS,
    });

    const stash = readTakeoverAvatarStash();
    expect(stash).not.toBeNull();
    expect(stash!.assistantId).toBe("a1");
    expect(stash!.traits).toEqual(TRAITS);
    expect(stash!.components.bodyShapes).toEqual(BUNDLED_COMPONENTS.bodyShapes);
    expect(stash!.savedAt).toBeGreaterThanOrEqual(before);
    expect(stash!.savedAt).toBeLessThanOrEqual(Date.now());
  });

  test("round-trips null traits", () => {
    saveTakeoverAvatarStash({
      assistantId: "a1",
      components: BUNDLED_COMPONENTS,
      traits: null,
    });

    expect(readTakeoverAvatarStash()!.traits).toBeNull();
  });

  test("returns null when nothing is stashed", () => {
    expect(readTakeoverAvatarStash()).toBeNull();
  });

  test("a stash older than 30 minutes reads as null and self-clears", () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        assistantId: "a1",
        components: BUNDLED_COMPONENTS,
        traits: TRAITS,
        savedAt: Date.now() - 31 * 60 * 1000,
      }),
    );

    expect(readTakeoverAvatarStash()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("a stash just inside the TTL still reads", () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        assistantId: "a1",
        components: BUNDLED_COMPONENTS,
        traits: TRAITS,
        savedAt: Date.now() - 29 * 60 * 1000,
      }),
    );

    expect(readTakeoverAvatarStash()).toMatchObject({ assistantId: "a1" });
  });

  test("corrupt JSON reads as null and self-clears", () => {
    sessionStorage.setItem(STORAGE_KEY, "{not json");

    expect(readTakeoverAvatarStash()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("a stash with malformed components reads as null and self-clears", () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        assistantId: "a1",
        components: { bodyShapes: "not-an-array" },
        traits: null,
        savedAt: Date.now(),
      }),
    );

    expect(readTakeoverAvatarStash()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("a stash with malformed traits reads as null and self-clears", () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        assistantId: "a1",
        components: BUNDLED_COMPONENTS,
        traits: { bodyShape: "blob" },
        savedAt: Date.now(),
      }),
    );

    expect(readTakeoverAvatarStash()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("a stash with no assistant id reads as null and self-clears", () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        components: BUNDLED_COMPONENTS,
        traits: null,
        savedAt: Date.now(),
      }),
    );

    expect(readTakeoverAvatarStash()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("clearTakeoverAvatarStash", () => {
  test("removes the stash", () => {
    saveTakeoverAvatarStash({
      assistantId: "a1",
      components: BUNDLED_COMPONENTS,
      traits: TRAITS,
    });
    clearTakeoverAvatarStash();

    expect(readTakeoverAvatarStash()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("in-memory fallback when sessionStorage is unavailable", () => {
  test("the mirror carries the stash past a throwing setItem", () => {
    // happy-dom's Storage is a Proxy, so overwriting `setItem` on it just
    // writes a storage entry — swap the whole global instead.
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      "sessionStorage",
    )!;
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("sessionStorage unavailable");
      },
      removeItem: () => {},
    };
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get: () => throwing,
    });
    try {
      saveTakeoverAvatarStash({
        assistantId: "a1",
        components: BUNDLED_COMPONENTS,
        traits: TRAITS,
      });

      expect(readTakeoverAvatarStash()).toMatchObject({ assistantId: "a1" });
    } finally {
      Object.defineProperty(globalThis, "sessionStorage", original);
    }
  });
});

describe("captureTakeoverAvatarStash", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
  });

  function seed(
    assistantId: string,
    data: {
      components: CharacterComponents | null;
      traits: CharacterTraits | null;
      customImageUrl: string | null;
    },
  ) {
    queryClient.setQueryData([...avatarQueryKey(assistantId), true], data);
  }

  /** A stash capture must overwrite or remove, never leave behind. */
  function preexistingStash() {
    saveTakeoverAvatarStash({
      assistantId: "old",
      components: BUNDLED_COMPONENTS,
      traits: TRAITS,
    });
  }

  test("stashes the active assistant's cached avatar", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "a1" });
    seed("a1", {
      components: BUNDLED_COMPONENTS,
      traits: TRAITS,
      customImageUrl: null,
    });

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toMatchObject({
      assistantId: "a1",
      traits: TRAITS,
    });
  });

  test("stashes a null-traits avatar", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "a1" });
    seed("a1", {
      components: BUNDLED_COMPONENTS,
      traits: null,
      customImageUrl: null,
    });

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toMatchObject({
      assistantId: "a1",
      traits: null,
    });
  });

  test("clears a pre-existing stash when there is no active assistant", () => {
    preexistingStash();

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toBeNull();
  });

  test("clears a pre-existing stash when the avatar is not cached", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "a1" });
    preexistingStash();

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toBeNull();
  });

  test("clears a pre-existing stash for a custom-image avatar", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "a1" });
    seed("a1", {
      components: BUNDLED_COMPONENTS,
      traits: null,
      customImageUrl: "blob:http://localhost/abc",
    });
    preexistingStash();

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toBeNull();
  });

  test("clears a pre-existing stash when components are null", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "a1" });
    seed("a1", {
      components: null,
      traits: TRAITS,
      customImageUrl: null,
    });
    preexistingStash();

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toBeNull();
  });
});
