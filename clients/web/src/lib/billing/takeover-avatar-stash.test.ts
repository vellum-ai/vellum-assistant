import { beforeEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import type { AvatarData } from "@/hooks/use-assistant-avatar";
import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import type { ResolvedAssistant } from "@/stores/resolved-assistants-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

import {
  captureTakeoverAvatarStash,
  clearTakeoverAvatarStash,
  readTakeoverAvatarStash,
  saveTakeoverAvatarStash,
  takeoverAvatarStashVersion,
} from "./takeover-avatar-stash";

const STORAGE_KEY = "vellum.pro-takeover-avatar";

const TRAITS: CharacterTraits = {
  bodyShape: "blob",
  eyeStyle: "curious",
  color: "purple",
};

const OTHER_TRAITS: CharacterTraits = {
  bodyShape: "square",
  eyeStyle: "wide",
  color: "green",
};

beforeEach(() => {
  sessionStorage.clear();
  // Reset the module-level in-memory mirror so it can't leak across tests.
  clearTakeoverAvatarStash();
  useResolvedAssistantsStore.setState({
    activeAssistantId: null,
    assistants: [],
    assistantsHydrated: false,
  });
});

function assistant(id: string): ResolvedAssistant {
  return { id, isLocal: false, isPlatformHosted: true, isPaired: false };
}

/** A hydrated list holding exactly one assistant: the only shape capture stashes. */
function soloOrg(id: string): void {
  useResolvedAssistantsStore.setState({
    activeAssistantId: id,
    assistants: [assistant(id)],
    assistantsHydrated: true,
  });
}

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

  // Every array here is dereferenced unconditionally while rendering, so a
  // stash missing one crashes the takeover rather than degrading.
  const MALFORMED_COMPONENTS: Array<[string, unknown, CharacterTraits?]> = [
    ["non-object components", "not-an-object"],
    ["a non-array bodyShapes", { ...BUNDLED_COMPONENTS, bodyShapes: "nope" }],
    ["a non-array eyeStyles", { ...BUNDLED_COMPONENTS, eyeStyles: "nope" }],
    ["a non-array colors", { ...BUNDLED_COMPONENTS, colors: "nope" }],
    [
      "a non-array faceCenterOverrides",
      { ...BUNDLED_COMPONENTS, faceCenterOverrides: "nope" },
    ],
    [
      "no faceCenterOverrides at all",
      {
        bodyShapes: BUNDLED_COMPONENTS.bodyShapes,
        eyeStyles: BUNDLED_COMPONENTS.eyeStyles,
        colors: BUNDLED_COMPONENTS.colors,
      },
    ],
    ["empty bodyShapes", { ...BUNDLED_COMPONENTS, bodyShapes: [] }],
    [
      "a bodyShape entry without a viewBox",
      {
        ...BUNDLED_COMPONENTS,
        bodyShapes: [
          { id: "blob", svgPath: "M0 0", faceCenter: { x: 1, y: 1 } },
        ],
      },
    ],
    [
      "an eyeStyle entry whose paths is not an array",
      {
        ...BUNDLED_COMPONENTS,
        eyeStyles: [
          {
            id: "default",
            sourceViewBox: { width: 1, height: 1 },
            eyeCenter: { x: 1, y: 1 },
            paths: "nope",
          },
        ],
      },
    ],
    [
      "a color entry without a hex",
      { ...BUNDLED_COMPONENTS, colors: [{ id: "purple" }] },
    ],
    [
      "a faceCenterOverride entry without a faceCenter",
      {
        ...BUNDLED_COMPONENTS,
        faceCenterOverrides: [{ bodyShape: "blob", eyeStyle: "curious" }],
      },
    ],

    [
      "traits whose bodyShape id is missing from the definitions",
      BUNDLED_COMPONENTS,
      { bodyShape: "not-a-shape", eyeStyle: "curious", color: "purple" },
    ],
  ];

  for (const [label, components, traits] of MALFORMED_COMPONENTS) {
    test(`a stash with ${label} reads as null and self-clears`, () => {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          assistantId: "a1",
          components,
          traits: traits ?? null,
          savedAt: Date.now(),
        }),
      );

      expect(readTakeoverAvatarStash()).toBeNull();
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  }

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

describe("takeoverAvatarStashVersion", () => {
  // A same-document reader snapshots the stash and re-reads when this moves,
  // so a write that leaves it flat would strand that reader on a stale copy.
  test("advances on save", () => {
    const before = takeoverAvatarStashVersion();

    saveTakeoverAvatarStash({
      assistantId: "a1",
      components: BUNDLED_COMPONENTS,
      traits: TRAITS,
    });

    expect(takeoverAvatarStashVersion()).toBeGreaterThan(before);
  });

  test("advances on clear", () => {
    saveTakeoverAvatarStash({
      assistantId: "a1",
      components: BUNDLED_COMPONENTS,
      traits: TRAITS,
    });
    const before = takeoverAvatarStashVersion();

    clearTakeoverAvatarStash();

    expect(takeoverAvatarStashVersion()).toBeGreaterThan(before);
  });
});

describe("in-memory mirror on a same-document return", () => {
  test("the mirror serves the stash back when sessionStorage throws", () => {
    // The native path: checkout opens in an external browser, so the document
    // is never unloaded and the module is still alive to answer. happy-dom's
    // Storage is a Proxy, so overwriting `setItem` on it just writes a storage
    // entry; swap the whole global instead.
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      "sessionStorage",
    )!;
    const throwing = {
      getItem: () => {
        throw new Error("sessionStorage unavailable");
      },
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

  test("the mirror serves a stash whose write never reached storage", () => {
    // The real failure mode: private mode and quota exhaustion break `setItem`
    // while `getItem` keeps answering, so only the write is lost and a
    // readable-empty store would otherwise read as absence.
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      "sessionStorage",
    )!;
    const writeFailing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {},
    };
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get: () => writeFailing,
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

  test("the mirror does not resurrect a stash sessionStorage no longer holds", () => {
    // Logout wipes sessionStorage wholesale, so a readable-but-empty store has
    // to read as absence or the previous account's avatar survives the wipe.
    saveTakeoverAvatarStash({
      assistantId: "a1",
      components: BUNDLED_COMPONENTS,
      traits: TRAITS,
    });
    sessionStorage.clear();

    expect(readTakeoverAvatarStash()).toBeNull();

    // That read released the mirror, so the stash cannot come back even once
    // storage stops answering.
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      "sessionStorage",
    )!;
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get: () => ({
        getItem: () => {
          throw new Error("sessionStorage unavailable");
        },
        setItem: () => {},
        removeItem: () => {},
      }),
    });
    try {
      expect(readTakeoverAvatarStash()).toBeNull();
    } finally {
      Object.defineProperty(globalThis, "sessionStorage", original);
    }
  });
});

test("a throwing sessionStorage property getter falls back to the mirror", () => {
  const realStorage = sessionStorage;
  saveTakeoverAvatarStash({
    assistantId: "a1",
    components: BUNDLED_COMPONENTS,
    traits: TRAITS,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get: () => {
      throw new Error("SecurityError");
    },
  });
  try {
    // The save above reached real storage, but with the getter itself throwing
    // the read must survive and serve the mirror rather than crash the render.
    expect(readTakeoverAvatarStash()?.assistantId).toBe("a1");
  } finally {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get: () => realStorage,
    });
  }
});

test("a failed overwrite serves the fresh mirror over the stale stored stash", () => {
  saveTakeoverAvatarStash({
    assistantId: "a1",
    components: BUNDLED_COMPONENTS,
    traits: TRAITS,
  });
  const realStorage = sessionStorage;
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get: () => ({
      getItem: (key: string) => realStorage.getItem(key),
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: (key: string) => realStorage.removeItem(key),
    }),
  });
  try {
    saveTakeoverAvatarStash({
      assistantId: "a2",
      components: BUNDLED_COMPONENTS,
      traits: TRAITS,
    });
    expect(readTakeoverAvatarStash()?.assistantId).toBe("a2");
  } finally {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get: () => realStorage,
    });
  }
});

describe("captureTakeoverAvatarStash", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
  });

  /**
   * The live query key appends a `supportsManifest` boolean, so a cache can
   * hold both variants at once; `supportsManifest` and `updatedAt` let a test
   * control which entry is stale and which order they land in.
   */
  function seed(
    assistantId: string,
    data: AvatarData,
    options?: { supportsManifest?: boolean; updatedAt?: number },
  ) {
    queryClient.setQueryData(
      [...avatarQueryKey(assistantId), options?.supportsManifest ?? true],
      data,
      { updatedAt: options?.updatedAt },
    );
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
    soloOrg("a1");
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
    soloOrg("a1");
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

  test("stashes when the org holds exactly one assistant", () => {
    useResolvedAssistantsStore.setState({
      activeAssistantId: "a1",
      assistants: [assistant("a1")],
      assistantsHydrated: true,
    });
    seed("a1", {
      components: BUNDLED_COMPONENTS,
      traits: TRAITS,
      customImageUrl: null,
    });

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toMatchObject({ assistantId: "a1" });
  });

  test("clears when the sole listed assistant is not the active id", () => {
    saveTakeoverAvatarStash({
      assistantId: "a1",
      components: BUNDLED_COMPONENTS,
      traits: TRAITS,
    });
    // A replaced list can briefly outlive a stale active id: length one alone
    // must not read as "the active assistant is the sole assistant".
    useResolvedAssistantsStore.setState({
      activeAssistantId: "a1",
      assistants: [assistant("a2")],
      assistantsHydrated: true,
    });
    seed("a1", {
      components: BUNDLED_COMPONENTS,
      traits: TRAITS,
      customImageUrl: null,
    });

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toBeNull();
  });

  test("clears instead of stashing before the list has hydrated", () => {
    // A persisted `activeAssistantId` reads through pre-hydration, so a list
    // that happens to show one assistant proves nothing about the org yet.
    useResolvedAssistantsStore.setState({
      activeAssistantId: "a1",
      assistants: [assistant("a1")],
      assistantsHydrated: false,
    });
    seed("a1", {
      components: BUNDLED_COMPONENTS,
      traits: TRAITS,
      customImageUrl: null,
    });
    preexistingStash();

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toBeNull();
  });

  test("clears instead of stashing when the hydrated list is empty", () => {
    useResolvedAssistantsStore.setState({
      activeAssistantId: "a1",
      assistants: [],
      assistantsHydrated: true,
    });
    seed("a1", {
      components: BUNDLED_COMPONENTS,
      traits: TRAITS,
      customImageUrl: null,
    });
    preexistingStash();

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toBeNull();
  });

  test("clears instead of stashing when a second assistant exists", () => {
    // The takeover targets the onboarding payload's primary, which need not be
    // the active assistant, and it draws before that target resolves.
    useResolvedAssistantsStore.setState({
      activeAssistantId: "a1",
      assistants: [assistant("a1"), assistant("a2")],
      assistantsHydrated: true,
    });
    seed("a1", {
      components: BUNDLED_COMPONENTS,
      traits: TRAITS,
      customImageUrl: null,
    });
    preexistingStash();

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toBeNull();
  });

  test("clears a pre-existing stash when there is no active assistant", () => {
    preexistingStash();

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toBeNull();
  });

  test("clears a pre-existing stash when the avatar is not cached", () => {
    soloOrg("a1");
    preexistingStash();

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toBeNull();
  });

  test("clears a pre-existing stash for a custom-image avatar", () => {
    soloOrg("a1");
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
    soloOrg("a1");
    seed("a1", {
      components: null,
      traits: TRAITS,
      customImageUrl: null,
    });
    preexistingStash();

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toBeNull();
  });

  test("stashes the freshest entry when the stale variant was cached first", () => {
    soloOrg("a1");
    const now = Date.now();
    seed(
      "a1",
      {
        components: BUNDLED_COMPONENTS,
        traits: OTHER_TRAITS,
        customImageUrl: null,
      },
      { supportsManifest: false, updatedAt: now - 60_000 },
    );
    seed(
      "a1",
      { components: BUNDLED_COMPONENTS, traits: TRAITS, customImageUrl: null },
      { supportsManifest: true, updatedAt: now },
    );

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toMatchObject({ traits: TRAITS });
  });

  test("stashes the freshest entry when the stale variant was cached last", () => {
    soloOrg("a1");
    const now = Date.now();
    seed(
      "a1",
      { components: BUNDLED_COMPONENTS, traits: TRAITS, customImageUrl: null },
      { supportsManifest: true, updatedAt: now },
    );
    seed(
      "a1",
      {
        components: BUNDLED_COMPONENTS,
        traits: OTHER_TRAITS,
        customImageUrl: null,
      },
      { supportsManifest: false, updatedAt: now - 60_000 },
    );

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toMatchObject({ traits: TRAITS });
  });

  test("a stale custom-image entry does not veto the freshest avatar", () => {
    soloOrg("a1");
    const now = Date.now();
    seed(
      "a1",
      {
        components: null,
        traits: null,
        customImageUrl: "blob:http://localhost/abc",
      },
      { supportsManifest: false, updatedAt: now - 60_000 },
    );
    seed(
      "a1",
      { components: BUNDLED_COMPONENTS, traits: TRAITS, customImageUrl: null },
      { supportsManifest: true, updatedAt: now },
    );

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toMatchObject({
      assistantId: "a1",
      traits: TRAITS,
    });
  });

  test("a fresh custom-image entry clears a stale drawable one", () => {
    soloOrg("a1");
    const now = Date.now();
    seed(
      "a1",
      { components: BUNDLED_COMPONENTS, traits: TRAITS, customImageUrl: null },
      { supportsManifest: false, updatedAt: now - 60_000 },
    );
    seed(
      "a1",
      {
        components: null,
        traits: null,
        customImageUrl: "blob:http://localhost/abc",
      },
      { supportsManifest: true, updatedAt: now },
    );
    preexistingStash();

    captureTakeoverAvatarStash(queryClient);

    expect(readTakeoverAvatarStash()).toBeNull();
  });
});
