/**
 * Scoped preparation runs across browser, Capacitor, Electron, and popouts
 * when either sender flag needs it. The legacy singleton remains exclusive to
 * the main Electron window with `push-avatar-sender` enabled.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useEffect } from "react";

import { NOTIFICATION_AVATAR_MAX_LOCAL_BYTES } from "@vellumai/avatar-manifest/notification-avatar";
import { NOTIFICATION_AVATAR_BASE64_MAX_CHARS } from "@vellumai/ipc-contract";

import type {
  AvatarImageMeta,
  CharacterComponents,
  CharacterTraits,
} from "@/types/avatar";
import type { NotificationAvatarScope } from "@/hooks/use-notification-avatar-sync";

const AVATAR_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

let electronHost = true;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => electronHost,
}));

const realPopoutWindow = await import("@/runtime/popout-window");
let popoutWindow = false;
mock.module("@/runtime/popout-window", () => ({
  ...realPopoutWindow,
  isPopoutWindowLifetime: () => popoutWindow,
}));

let rasterized: Uint8Array | null = AVATAR_PNG;
/** Set to stall the rasterizer so the mid-render window can be observed. */
let rasterizeGate: Promise<void> | null = null;
let rasterizeThrows = false;
const rasterizeNotificationAvatar = mock(
  async (_src: string, _accentHex: string | null) => {
    if (rasterizeGate) {
      await rasterizeGate;
    }
    if (rasterizeThrows) {
      throw new Error("the canvas went away");
    }
    return rasterized;
  },
);
mock.module("@/utils/avatar-raster", () => ({ rasterizeNotificationAvatar }));

const {
  __clearNotificationIdentitySnapshotsForTests,
  createNotificationIdentity,
  getNotificationAvatar,
  getNotificationIdentitySnapshot,
  reconcilePreparedNotificationIdentityOwners,
  resetNotificationIdentitySession,
  setNotificationIdentityNativeAdapter,
  sha256Hex,
} = await import("@/runtime/notification-avatar");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");
const { resolveNotificationAvatarScope, useNotificationAvatarSync } =
  await import("@/hooks/use-notification-avatar-sync");

const ASSISTANT_ID = "assistant-1";
const IMAGE_URL = "blob:avatar-1";
const ACCENT = "#E9642F";
/** What the daemon's manifest says the uploaded image is, across refetches. */
const IMAGE_META: AvatarImageMeta = {
  updatedAt: "2026-01-01T00:00:00.000Z",
  etag: "etag-a",
};
const CONNECTION_SCOPE = {
  kind: "connection" as const,
  url: "https://assistant.example.com/v1",
};

function preparedIdentity(
  assistantId = ASSISTANT_ID,
  scope: NotificationAvatarScope = CONNECTION_SCOPE,
  platformAssistantId?: string,
) {
  const scopeId = resolveNotificationAvatarScope(scope)!;
  return createNotificationIdentity(scopeId, assistantId, platformAssistantId)!;
}

const preparedOptions = (
  assistantName = "Assistant One",
  avatarReady = true,
  scope: NotificationAvatarScope = CONNECTION_SCOPE,
  platformAssistantId?: string,
  ownerAssistantId = ASSISTANT_ID,
) => {
  const scopeId = resolveNotificationAvatarScope(scope)!;
  return {
    scopeId,
    platformAssistantId,
    assistantName,
    assistantNameOwner: { scopeId, assistantId: ownerAssistantId },
    avatarOwner: { scopeId, assistantId: ownerAssistantId },
    avatarReady,
  };
};

/**
 * Components and traits that name nothing in the palette, so the render falls
 * through to the uploaded image. Fresh objects stand in for the identities the
 * avatar query hands out again on every refetch.
 */
const staleComponents = (): CharacterComponents => ({
  bodyShapes: [],
  eyeStyles: [],
  colors: [],
  faceCenterOverrides: [],
});
const staleTraits = (): CharacterTraits => ({
  bodyShape: "gone",
  eyeStyle: "gone",
  color: "gone",
});

const render = (accentHex: string | null = ACCENT) =>
  renderHook(() =>
    useNotificationAvatarSync(
      ASSISTANT_ID,
      IMAGE_URL,
      IMAGE_META,
      null,
      null,
      accentHex,
    ),
  );

beforeEach(() => {
  electronHost = true;
  popoutWindow = false;
  rasterized = AVATAR_PNG;
  rasterizeGate = null;
  rasterizeThrows = false;
  rasterizeNotificationAvatar.mockClear();
  __clearNotificationIdentitySnapshotsForTests();
  useClientFeatureFlagStore.setState({
    pushAvatarSender: true,
    localNotificationAvatar: false,
  });
});

afterEach(() => {
  cleanup();
  __clearNotificationIdentitySnapshotsForTests();
  useClientFeatureFlagStore.setState({
    pushAvatarSender: false,
    localNotificationAvatar: false,
  });
});

describe("useNotificationAvatarSync", () => {
  test("holds the composited avatar, its hash and its assistant on Electron with the flag on", async () => {
    render();

    await waitFor(() => {
      expect(getNotificationAvatar()).not.toBeNull();
    });
    expect(rasterizeNotificationAvatar).toHaveBeenCalledWith(IMAGE_URL, ACCENT);
    expect(getNotificationAvatar()).toEqual({
      assistantId: ASSISTANT_ID,
      avatarBase64: "iVBORw==",
      avatarHash: await sha256Hex(AVATAR_PNG),
    });
  });

  test("prepares off Electron without touching the legacy holder", async () => {
    electronHost = false;

    render();

    await waitFor(() => {
      expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(1);
    });
    expect(getNotificationAvatar()).toBeNull();
  });

  test("prepares in a pop-out without touching the legacy holder", async () => {
    popoutWindow = true;

    render();

    await waitFor(() => {
      expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(1);
    });
    expect(getNotificationAvatar()).toBeNull();
  });

  test("does no canvas work and holds nothing with the flag off", async () => {
    useClientFeatureFlagStore.setState({ pushAvatarSender: false });

    render();

    await waitFor(() => {
      expect(rasterizeNotificationAvatar).not.toHaveBeenCalled();
    });
    expect(getNotificationAvatar()).toBeNull();
  });

  test("takes back a held avatar when the flag turns off", async () => {
    const { rerender } = render();
    await waitFor(() => {
      expect(getNotificationAvatar()).not.toBeNull();
    });

    act(() => {
      useClientFeatureFlagStore.setState({ pushAvatarSender: false });
    });
    rerender();

    await waitFor(() => {
      expect(getNotificationAvatar()).toBeNull();
    });
  });

  test("empties the holder when the hook goes away", async () => {
    const { unmount } = render();
    await waitFor(() => {
      expect(getNotificationAvatar()).not.toBeNull();
    });

    unmount();

    expect(getNotificationAvatar()).toBeNull();
  });

  test("holds nothing for an assistant with no avatar to draw", async () => {
    renderHook(() =>
      useNotificationAvatarSync(ASSISTANT_ID, null, null, null, null, ACCENT),
    );

    await waitFor(() => {
      expect(rasterizeNotificationAvatar).not.toHaveBeenCalled();
    });
    expect(getNotificationAvatar()).toBeNull();
  });

  test("holds nothing while there is no active assistant", async () => {
    renderHook(() =>
      useNotificationAvatarSync(
        null,
        IMAGE_URL,
        IMAGE_META,
        null,
        null,
        ACCENT,
      ),
    );

    await waitFor(() => {
      expect(rasterizeNotificationAvatar).not.toHaveBeenCalled();
    });
    expect(getNotificationAvatar()).toBeNull();
  });

  test("holds nothing when the rasterizer gives back no bytes", async () => {
    rasterized = null;

    render();

    await waitFor(() => {
      expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(1);
    });
    expect(getNotificationAvatar()).toBeNull();
  });

  test("holds nothing for a render past the local byte cap", async () => {
    rasterized = new Uint8Array(NOTIFICATION_AVATAR_MAX_LOCAL_BYTES + 1);

    render();

    await waitFor(() => {
      expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(1);
    });
    expect(getNotificationAvatar()).toBeNull();
  });

  test("keeps the held avatar across a refetch that redraws the same picture", async () => {
    const { rerender } = renderHook(
      ({
        components,
        traits,
      }: {
        components: CharacterComponents;
        traits: CharacterTraits;
      }) =>
        useNotificationAvatarSync(
          ASSISTANT_ID,
          IMAGE_URL,
          IMAGE_META,
          components,
          traits,
          ACCENT,
        ),
      {
        initialProps: { components: staleComponents(), traits: staleTraits() },
      },
    );
    await waitFor(() => {
      expect(getNotificationAvatar()).not.toBeNull();
    });
    const held = getNotificationAvatar();

    rerender({ components: staleComponents(), traits: staleTraits() });

    expect(getNotificationAvatar()).toEqual(held);
    expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(1);
  });

  test("empties the holder before drawing a replacement, then holds the new assistant's avatar", async () => {
    const { rerender } = renderHook(
      ({ id, url }: { id: string; url: string }) =>
        useNotificationAvatarSync(id, url, null, null, null, ACCENT),
      { initialProps: { id: ASSISTANT_ID, url: IMAGE_URL } },
    );
    await waitFor(() => {
      expect(getNotificationAvatar()).not.toBeNull();
    });

    let releaseRasterize = () => {};
    rasterizeGate = new Promise<void>((resolve) => {
      releaseRasterize = resolve;
    });
    rerender({ id: "assistant-2", url: "blob:avatar-2" });

    expect(getNotificationAvatar()).toBeNull();

    releaseRasterize();
    await waitFor(() => {
      expect(getNotificationAvatar()?.assistantId).toBe("assistant-2");
    });
  });

  test("draws again on the next refetch after a render that gave nothing back", async () => {
    rasterized = null;
    const { rerender } = renderHook(
      ({
        components,
        traits,
      }: {
        components: CharacterComponents;
        traits: CharacterTraits;
      }) =>
        useNotificationAvatarSync(
          ASSISTANT_ID,
          IMAGE_URL,
          IMAGE_META,
          components,
          traits,
          ACCENT,
        ),
      {
        initialProps: { components: staleComponents(), traits: staleTraits() },
      },
    );
    await waitFor(() => {
      expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(1);
    });
    await act(async () => {});

    rasterized = AVATAR_PNG;
    rerender({ components: staleComponents(), traits: staleTraits() });

    await waitFor(() => {
      expect(getNotificationAvatar()).not.toBeNull();
    });
    // The render that gave nothing back, the one redraw it scheduled (which
    // gave nothing back either), and the refetch.
    expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(3);
  });

  test("draws again on the next refetch after the rasterizer threw", async () => {
    rasterizeThrows = true;
    const { rerender } = renderHook(
      ({
        components,
        traits,
      }: {
        components: CharacterComponents;
        traits: CharacterTraits;
      }) =>
        useNotificationAvatarSync(
          ASSISTANT_ID,
          IMAGE_URL,
          IMAGE_META,
          components,
          traits,
          ACCENT,
        ),
      {
        initialProps: { components: staleComponents(), traits: staleTraits() },
      },
    );
    await waitFor(() => {
      expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(1);
    });
    await act(async () => {});

    rasterizeThrows = false;
    rerender({ components: staleComponents(), traits: staleTraits() });

    await waitFor(() => {
      expect(getNotificationAvatar()).not.toBeNull();
    });
    // The render that threw, the one redraw it scheduled (which threw too),
    // and the refetch.
    expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(3);
  });

  test("redraws from the URL a refetch minted under a render that then failed", async () => {
    let releaseFirst = () => {};
    let releaseRedraw = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const redrawGate = new Promise<void>((resolve) => {
      releaseRedraw = resolve;
    });
    rasterizeGate = firstGate;
    rasterizeThrows = true;
    const { rerender } = renderHook(
      ({ url }: { url: string }) =>
        useNotificationAvatarSync(
          ASSISTANT_ID,
          url,
          IMAGE_META,
          null,
          null,
          ACCENT,
        ),
      { initialProps: { url: IMAGE_URL } },
    );
    await waitFor(() => {
      expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(1);
    });

    // A refetch mints a new URL for the same image while the first render is
    // still in flight. The key is the image's identity, so that run matches it
    // and returns: only the redraw the failure schedules can draw from the URL
    // that is still live.
    rerender({ url: "blob:avatar-1-refetched" });
    rasterizeGate = redrawGate;
    releaseFirst();
    await waitFor(() => {
      expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(2);
    });

    rasterizeThrows = false;
    releaseRedraw();

    await waitFor(() => {
      expect(getNotificationAvatar()).not.toBeNull();
    });
    expect(rasterizeNotificationAvatar).toHaveBeenLastCalledWith(
      "blob:avatar-1-refetched",
      ACCENT,
    );
  });

  test("schedules one redraw, not a loop, for a picture that never draws", async () => {
    rasterizeThrows = true;
    render();

    await waitFor(() => {
      expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(2);
    });
    await act(async () => {});
    await act(async () => {});

    expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(2);
    expect(getNotificationAvatar()).toBeNull();
  });

  test("keeps the held avatar when a refetch mints a new URL for the same image", async () => {
    const { rerender } = renderHook(
      ({ url }: { url: string }) =>
        useNotificationAvatarSync(
          ASSISTANT_ID,
          url,
          IMAGE_META,
          null,
          null,
          ACCENT,
        ),
      { initialProps: { url: IMAGE_URL } },
    );
    await waitFor(() => {
      expect(getNotificationAvatar()).not.toBeNull();
    });
    const held = getNotificationAvatar();

    rerender({ url: "blob:avatar-1-refetched" });

    expect(getNotificationAvatar()).toEqual(held);
    expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(1);
  });

  test("redraws when the manifest says the uploaded image changed", async () => {
    const { rerender } = renderHook(
      ({ url, meta }: { url: string; meta: AvatarImageMeta }) =>
        useNotificationAvatarSync(ASSISTANT_ID, url, meta, null, null, ACCENT),
      { initialProps: { url: IMAGE_URL, meta: IMAGE_META } },
    );
    await waitFor(() => {
      expect(getNotificationAvatar()).not.toBeNull();
    });

    rerender({
      url: "blob:avatar-2",
      meta: { ...IMAGE_META, etag: "etag-b" },
    });

    await waitFor(() => {
      expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(2);
    });
    expect(rasterizeNotificationAvatar).toHaveBeenLastCalledWith(
      "blob:avatar-2",
      ACCENT,
    );
  });

  test("a render the holder has moved past never lands", async () => {
    const { rerender } = renderHook(
      ({ id, url }: { id: string; url: string }) =>
        useNotificationAvatarSync(id, url, null, null, null, ACCENT),
      { initialProps: { id: ASSISTANT_ID, url: IMAGE_URL } },
    );

    let releaseRasterize = () => {};
    rasterizeGate = new Promise<void>((resolve) => {
      releaseRasterize = resolve;
    });
    rerender({ id: "assistant-2", url: "blob:avatar-2" });
    rasterizeGate = null;
    rerender({ id: "assistant-3", url: "blob:avatar-3" });
    releaseRasterize();

    await waitFor(() => {
      expect(getNotificationAvatar()?.assistantId).toBe("assistant-3");
    });
  });
});

describe("scoped notification identity preparation", () => {
  test("prepares for every enabled flag combination and stays cold when both are off", async () => {
    electronHost = false;
    const cases = [
      { pushAvatarSender: false, localNotificationAvatar: false, runs: false },
      { pushAvatarSender: true, localNotificationAvatar: false, runs: true },
      { pushAvatarSender: false, localNotificationAvatar: true, runs: true },
      { pushAvatarSender: true, localNotificationAvatar: true, runs: true },
    ];

    for (const flags of cases) {
      __clearNotificationIdentitySnapshotsForTests();
      rasterizeNotificationAvatar.mockClear();
      useClientFeatureFlagStore.setState(flags);
      const view = renderHook(() =>
        useNotificationAvatarSync(
          ASSISTANT_ID,
          IMAGE_URL,
          IMAGE_META,
          null,
          null,
          ACCENT,
          preparedOptions(),
        ),
      );

      if (flags.runs) {
        await waitFor(() => {
          expect(
            getNotificationIdentitySnapshot(preparedIdentity())?.avatar,
          ).toBeDefined();
        });
      } else {
        await act(async () => {});
        expect(rasterizeNotificationAvatar).not.toHaveBeenCalled();
        expect(getNotificationIdentitySnapshot(preparedIdentity())).toBeNull();
      }
      view.unmount();
    }
  });

  test("local-only preparation does not populate the Electron singleton", async () => {
    useClientFeatureFlagStore.setState({
      pushAvatarSender: false,
      localNotificationAvatar: true,
    });
    renderHook(() =>
      useNotificationAvatarSync(
        ASSISTANT_ID,
        IMAGE_URL,
        IMAGE_META,
        null,
        null,
        ACCENT,
        preparedOptions(),
      ),
    );

    await waitFor(() => {
      expect(
        getNotificationIdentitySnapshot(preparedIdentity())?.avatar,
      ).toBeDefined();
    });
    expect(getNotificationAvatar()).toBeNull();
  });

  test("publishes the exact name during startup before avatar data is ready", async () => {
    electronHost = false;
    useClientFeatureFlagStore.setState({
      pushAvatarSender: false,
      localNotificationAvatar: true,
    });
    const { rerender } = renderHook(
      ({ url, ready }: { url: string | null; ready: boolean }) =>
        useNotificationAvatarSync(
          ASSISTANT_ID,
          url,
          url ? IMAGE_META : null,
          null,
          null,
          ACCENT,
          preparedOptions("Exact Name", ready),
        ),
      { initialProps: { url: null as string | null, ready: false } },
    );

    expect(getNotificationIdentitySnapshot(preparedIdentity())).toMatchObject({
      name: "Exact Name",
      nameProvenance: "identity-store",
    });
    expect(rasterizeNotificationAvatar).not.toHaveBeenCalled();

    rerender({ url: IMAGE_URL, ready: true });
    await waitFor(() => {
      expect(
        getNotificationIdentitySnapshot(preparedIdentity())?.avatar,
      ).toBeDefined();
    });
  });

  test("waits for an explicit owner scope during session startup", async () => {
    renderHook(() =>
      useNotificationAvatarSync(
        ASSISTANT_ID,
        IMAGE_URL,
        IMAGE_META,
        null,
        null,
        ACCENT,
        { ...preparedOptions(), scopeId: null },
      ),
    );

    await act(async () => {});
    expect(rasterizeNotificationAvatar).not.toHaveBeenCalled();
    expect(getNotificationIdentitySnapshot(preparedIdentity())).toBeNull();
  });

  test("does not publish avatar or name data owned by another scope", async () => {
    const scopeId = resolveNotificationAvatarScope(CONNECTION_SCOPE)!;
    const wrongScopeId = resolveNotificationAvatarScope({
      kind: "connection",
      url: "https://other.example.com",
    })!;
    const { rerender } = renderHook(
      ({ ownerScopeId }: { ownerScopeId: string }) =>
        useNotificationAvatarSync(
          ASSISTANT_ID,
          IMAGE_URL,
          IMAGE_META,
          null,
          null,
          ACCENT,
          {
            scopeId,
            assistantName: "Exact Name",
            assistantNameOwner: {
              scopeId: ownerScopeId,
              assistantId: ASSISTANT_ID,
            },
            avatarOwner: {
              scopeId: ownerScopeId,
              assistantId: ASSISTANT_ID,
            },
            avatarReady: true,
          },
        ),
      { initialProps: { ownerScopeId: wrongScopeId } },
    );

    await act(async () => {});
    expect(rasterizeNotificationAvatar).not.toHaveBeenCalled();
    expect(getNotificationIdentitySnapshot(preparedIdentity())).toBeNull();

    rerender({ ownerScopeId: scopeId });
    await waitFor(() => {
      expect(
        getNotificationIdentitySnapshot(preparedIdentity())?.avatar,
      ).toBeDefined();
    });
    expect(getNotificationIdentitySnapshot(preparedIdentity())?.name).toBe(
      "Exact Name",
    );
  });

  test("updates a verified name independently without redrawing a warm avatar", async () => {
    const { rerender } = renderHook(
      ({ name }: { name: string }) =>
        useNotificationAvatarSync(
          ASSISTANT_ID,
          IMAGE_URL,
          IMAGE_META,
          null,
          null,
          ACCENT,
          preparedOptions(name),
        ),
      { initialProps: { name: "First Name" } },
    );
    await waitFor(() => {
      expect(
        getNotificationIdentitySnapshot(preparedIdentity())?.avatar,
      ).toBeDefined();
    });

    rerender({ name: "Renamed Assistant" });

    await waitFor(() => {
      expect(getNotificationIdentitySnapshot(preparedIdentity())?.name).toBe(
        "Renamed Assistant",
      );
    });
    expect(
      getNotificationIdentitySnapshot(preparedIdentity())?.avatar,
    ).toBeDefined();
    expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(1);
  });

  test("restarts an in-flight avatar under a newer name revision", async () => {
    let releaseRasterize = () => {};
    rasterizeGate = new Promise<void>((resolve) => {
      releaseRasterize = resolve;
    });
    const { rerender } = renderHook(
      ({ name }: { name: string }) =>
        useNotificationAvatarSync(
          ASSISTANT_ID,
          IMAGE_URL,
          IMAGE_META,
          null,
          null,
          ACCENT,
          preparedOptions(name),
        ),
      { initialProps: { name: "First Name" } },
    );
    await waitFor(() => {
      expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(1);
    });

    rasterizeGate = null;
    rerender({ name: "Renamed Assistant" });
    releaseRasterize();

    await waitFor(() => {
      expect(getNotificationIdentitySnapshot(preparedIdentity())).toMatchObject(
        {
          name: "Renamed Assistant",
          avatar: { avatarBase64: "iVBORw==" },
        },
      );
    });
    expect(rasterizeNotificationAvatar).toHaveBeenCalledTimes(2);
  });

  test("retains a verified old assistant while publishing a switched assistant", async () => {
    const { rerender } = renderHook(
      ({ id, url }: { id: string; url: string }) =>
        useNotificationAvatarSync(
          id,
          url,
          null,
          null,
          null,
          ACCENT,
          preparedOptions(id, true, CONNECTION_SCOPE, undefined, id),
        ),
      { initialProps: { id: ASSISTANT_ID, url: IMAGE_URL } },
    );
    await waitFor(() => {
      expect(
        getNotificationIdentitySnapshot(preparedIdentity()),
      ).not.toBeNull();
    });

    rerender({ id: "assistant-2", url: "blob:avatar-2" });

    await waitFor(() => {
      expect(
        getNotificationIdentitySnapshot(preparedIdentity("assistant-2"))
          ?.avatar,
      ).toBeDefined();
    });
    expect(
      getNotificationIdentitySnapshot(preparedIdentity())?.avatar,
    ).toBeDefined();
  });

  test("clears a prepared identity when the active assistant is removed", async () => {
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) =>
        useNotificationAvatarSync(
          id,
          IMAGE_URL,
          IMAGE_META,
          null,
          null,
          ACCENT,
          preparedOptions(),
        ),
      { initialProps: { id: ASSISTANT_ID as string | null } },
    );
    await waitFor(() => {
      expect(
        getNotificationIdentitySnapshot(preparedIdentity())?.avatar,
      ).toBeDefined();
    });

    rerender({ id: null });

    await waitFor(() => {
      expect(getNotificationIdentitySnapshot(preparedIdentity())).toBeNull();
    });
  });

  test("a stale popout render cannot publish over the switched identity", async () => {
    popoutWindow = true;
    let releaseRasterize = () => {};
    rasterizeGate = new Promise<void>((resolve) => {
      releaseRasterize = resolve;
    });
    const { rerender } = renderHook(
      ({ id, url }: { id: string; url: string }) =>
        useNotificationAvatarSync(
          id,
          url,
          null,
          null,
          null,
          ACCENT,
          preparedOptions(id, true, CONNECTION_SCOPE, undefined, id),
        ),
      { initialProps: { id: ASSISTANT_ID, url: IMAGE_URL } },
    );

    rasterizeGate = null;
    rerender({ id: "assistant-2", url: "blob:avatar-2" });
    releaseRasterize();

    await waitFor(() => {
      expect(
        getNotificationIdentitySnapshot(preparedIdentity("assistant-2"))
          ?.avatar,
      ).toBeDefined();
    });
    expect(getNotificationIdentitySnapshot(preparedIdentity())).toMatchObject({
      name: ASSISTANT_ID,
    });
    expect(
      getNotificationIdentitySnapshot(preparedIdentity())?.avatar,
    ).toBeUndefined();
    expect(getNotificationAvatar()).toBeNull();
  });

  test("logout during preparation resets native memory and rejects late bytes", async () => {
    electronHost = false;
    useClientFeatureFlagStore.setState({
      pushAvatarSender: false,
      localNotificationAvatar: true,
    });
    let releaseRasterize = () => {};
    rasterizeGate = new Promise<void>((resolve) => {
      releaseRasterize = resolve;
    });
    const prepares: Array<{ scopeEpoch: number; avatar?: unknown }> = [];
    const resets: Array<{ scopeEpoch: number }> = [];
    setNotificationIdentityNativeAdapter({
      prepareIdentity: async (payload) => {
        prepares.push(payload);
      },
      resetIdentities: async (payload) => {
        resets.push(payload);
      },
    });
    renderHook(() =>
      useNotificationAvatarSync(
        ASSISTANT_ID,
        IMAGE_URL,
        IMAGE_META,
        null,
        null,
        ACCENT,
        preparedOptions(),
      ),
    );
    await waitFor(() => {
      expect(prepares.length).toBe(1);
    });

    resetNotificationIdentitySession();
    releaseRasterize();
    await act(async () => {});

    expect(getNotificationIdentitySnapshot(preparedIdentity())).toBeNull();
    expect(prepares.filter((payload) => payload.avatar).length).toBe(0);
    expect(resets.length).toBe(1);
    expect(resets[0]!.scopeEpoch).toBeGreaterThan(prepares[0]!.scopeEpoch);
  });

  test("a same-owner reactivation publishes above the session reset epoch", async () => {
    const prepares: Array<{ scopeEpoch: number }> = [];
    const resets: Array<{ scopeEpoch: number }> = [];
    setNotificationIdentityNativeAdapter({
      prepareIdentity: async (payload) => {
        prepares.push(payload);
      },
      resetIdentities: async (payload) => {
        resets.push(payload);
      },
    });
    const { rerender } = renderHook(
      ({ renderCount }: { renderCount: number }) => {
        void renderCount;
        useNotificationAvatarSync(
          ASSISTANT_ID,
          IMAGE_URL,
          IMAGE_META,
          null,
          null,
          ACCENT,
          preparedOptions(),
        );
      },
      { initialProps: { renderCount: 0 } },
    );
    await waitFor(() => {
      expect(
        getNotificationIdentitySnapshot(preparedIdentity())?.avatar,
      ).toBeDefined();
    });

    resetNotificationIdentitySession();
    resetNotificationIdentitySession();
    rerender({ renderCount: 1 });

    await waitFor(() => {
      expect(
        getNotificationIdentitySnapshot(preparedIdentity())?.avatar,
      ).toBeDefined();
    });
    expect(resets.length).toBe(1);
    expect(prepares.at(-1)!.scopeEpoch).toBeGreaterThan(
      resets[0]!.scopeEpoch,
    );
  });

  test("a self-hosted origin change retires the old scope", async () => {
    const firstScope = {
      kind: "connection" as const,
      url: "https://first.example.com/path",
    };
    const secondScope = {
      kind: "connection" as const,
      url: "https://second.example.com/other",
    };
    const nativeResets: Array<{ scopeId: string; assistantId?: string }> = [];
    setNotificationIdentityNativeAdapter({
      resetIdentities: (payload) => {
        nativeResets.push(payload);
      },
    });
    const { rerender } = renderHook(
      ({
        scope,
        ownerScope,
      }: {
        scope: NotificationAvatarScope;
        ownerScope: NotificationAvatarScope;
      }) => {
        const options = preparedOptions("Assistant One", true, scope);
        const ownerScopeId = resolveNotificationAvatarScope(ownerScope)!;
        useEffect(() => {
          reconcilePreparedNotificationIdentityOwners([
            { scopeId: options.scopeId, assistantId: ASSISTANT_ID },
          ]);
        }, [options.scopeId]);
        useNotificationAvatarSync(
          ASSISTANT_ID,
          IMAGE_URL,
          IMAGE_META,
          null,
          null,
          ACCENT,
          {
            ...options,
            assistantNameOwner: {
              scopeId: ownerScopeId,
              assistantId: ASSISTANT_ID,
            },
            avatarOwner: { scopeId: ownerScopeId, assistantId: ASSISTANT_ID },
          },
        );
      },
      { initialProps: { scope: firstScope, ownerScope: firstScope } },
    );
    const firstIdentity = preparedIdentity(ASSISTANT_ID, firstScope);
    await waitFor(() => {
      expect(getNotificationIdentitySnapshot(firstIdentity)?.avatar).toBeDefined();
    });

    const secondScopeId = resolveNotificationAvatarScope(secondScope)!;
    const firstScopeId = resolveNotificationAvatarScope(firstScope)!;
    rerender({ scope: secondScope, ownerScope: firstScope });
    const secondIdentity = preparedIdentity(ASSISTANT_ID, secondScope);
    await act(async () => {});
    expect(getNotificationIdentitySnapshot(secondIdentity)).toBeNull();

    rerender({ scope: secondScope, ownerScope: secondScope });
    await waitFor(() => {
      expect(
        getNotificationIdentitySnapshot(secondIdentity)?.avatar,
      ).toBeDefined();
    });
    expect(secondScopeId).not.toBe(firstScopeId);

    expect(getNotificationIdentitySnapshot(firstIdentity)).toBeNull();
    expect(firstIdentity.nativeSenderId).not.toBe(secondIdentity.nativeSenderId);
    expect(nativeResets).toHaveLength(1);
    expect(nativeResets[0]).toMatchObject({ scopeId: firstScopeId });
    expect(nativeResets[0]).not.toHaveProperty("assistantId");
  });

  test("keeps a same-owner avatar during loading but clears it on conclusive removal", async () => {
    const { rerender } = renderHook(
      ({ url, ready }: { url: string | null; ready: boolean }) =>
        useNotificationAvatarSync(
          ASSISTANT_ID,
          url,
          url ? IMAGE_META : null,
          null,
          null,
          ACCENT,
          preparedOptions("Assistant One", ready),
        ),
      {
        initialProps: { url: IMAGE_URL as string | null, ready: true },
      },
    );
    await waitFor(() => {
      expect(
        getNotificationIdentitySnapshot(preparedIdentity())?.avatar,
      ).toBeDefined();
    });

    rerender({ url: null, ready: false });
    expect(
      getNotificationIdentitySnapshot(preparedIdentity())?.avatar,
    ).toBeDefined();

    rerender({ url: null, ready: true });
    await waitFor(() => {
      expect(
        getNotificationIdentitySnapshot(preparedIdentity())?.avatar,
      ).toBeUndefined();
    });
    expect(getNotificationIdentitySnapshot(preparedIdentity())?.name).toBe(
      "Assistant One",
    );
  });

  test("disabling both flags clears a prepared identity", async () => {
    const { rerender } = renderHook(() => {
      useNotificationAvatarSync(
        ASSISTANT_ID,
        IMAGE_URL,
        IMAGE_META,
        null,
        null,
        ACCENT,
        preparedOptions(),
      );
    });
    await waitFor(() => {
      expect(
        getNotificationIdentitySnapshot(preparedIdentity()),
      ).not.toBeNull();
    });

    act(() => {
      useClientFeatureFlagStore.setState({
        pushAvatarSender: false,
        localNotificationAvatar: false,
      });
    });
    rerender();

    await waitFor(() => {
      expect(getNotificationIdentitySnapshot(preparedIdentity())).toBeNull();
    });
  });

  test("uses account/org isolation and preserves an explicit platform sender id", async () => {
    const accountScope: NotificationAvatarScope = {
      kind: "account",
      accountId: "user-123",
      organizationId: "org-abc",
    };
    const nativeId = "00000000-0000-4000-8000-000000000001";
    const nativeScopes: string[] = [];
    setNotificationIdentityNativeAdapter({
      prepareIdentity: (payload) => {
        nativeScopes.push(payload.identity.scopeId);
      },
    });
    renderHook(() =>
      useNotificationAvatarSync(
        ASSISTANT_ID,
        IMAGE_URL,
        IMAGE_META,
        null,
        null,
        ACCENT,
        preparedOptions("Assistant One", true, accountScope, nativeId),
      ),
    );
    const identity = preparedIdentity(ASSISTANT_ID, accountScope, nativeId);

    await waitFor(() => {
      expect(getNotificationIdentitySnapshot(identity)?.avatar).toBeDefined();
    });
    expect(identity.nativeSenderId).toBe(nativeId);
    expect(nativeScopes).not.toContain(
      JSON.stringify(["account", "user-123", "org-abc"]),
    );
    expect(nativeScopes.every((scopeId) => /^scope:v1:[a-f0-9]{64}$/.test(scopeId))).toBe(
      true,
    );
    expect(resolveNotificationAvatarScope(accountScope)).not.toBe(
      resolveNotificationAvatarScope({
        ...accountScope,
        organizationId: "org-other",
      }),
    );
    expect(
      resolveNotificationAvatarScope({
        kind: "connection",
        url: "https://assistant.example.com/another/path",
      }),
    ).toBe(resolveNotificationAvatarScope(CONNECTION_SCOPE));
  });
});

describe("the bytes the holder passes on", () => {
  test("fit what the IPC boundary accepts", () => {
    expect(NOTIFICATION_AVATAR_BASE64_MAX_CHARS).toBe(
      Math.ceil(NOTIFICATION_AVATAR_MAX_LOCAL_BYTES / 3) * 4,
    );
  });
});
