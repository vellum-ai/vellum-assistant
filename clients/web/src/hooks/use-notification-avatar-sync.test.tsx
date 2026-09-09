/**
 * The gate this hook exists to hold: the notification avatar is composited and
 * held only in the main Electron window with `push-avatar-sender` on. Every
 * other host, a pop-out thread window, and the flag off must leave the holder
 * empty so the IPC payload carries no `sender` field, and a flag that turns
 * off, or a hook that goes away, has to take back what an earlier run stored.
 * What is held is stamped with the assistant it was drawn for, a replacement
 * render empties the holder before it starts drawing, and a re-run for the
 * picture already held leaves it alone.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { NOTIFICATION_AVATAR_MAX_LOCAL_BYTES } from "@vellumai/avatar-manifest/notification-avatar";
import { NOTIFICATION_AVATAR_BASE64_MAX_CHARS } from "@vellumai/ipc-contract";

import type {
  AvatarImageMeta,
  CharacterComponents,
  CharacterTraits,
} from "@/types/avatar";

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

const { clearNotificationAvatar, getNotificationAvatar, sha256Hex } =
  await import("@/runtime/notification-avatar");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");
const { useNotificationAvatarSync } =
  await import("@/hooks/use-notification-avatar-sync");

const ASSISTANT_ID = "assistant-1";
const IMAGE_URL = "blob:avatar-1";
const ACCENT = "#E9642F";
/** What the daemon's manifest says the uploaded image is, across refetches. */
const IMAGE_META: AvatarImageMeta = {
  updatedAt: "2026-01-01T00:00:00.000Z",
  etag: "etag-a",
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
  clearNotificationAvatar();
  useClientFeatureFlagStore.setState({ pushAvatarSender: true });
});

afterEach(() => {
  cleanup();
  clearNotificationAvatar();
  useClientFeatureFlagStore.setState({ pushAvatarSender: false });
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

  test("does no canvas work and holds nothing off Electron", async () => {
    electronHost = false;

    render();

    await waitFor(() => {
      expect(rasterizeNotificationAvatar).not.toHaveBeenCalled();
    });
    expect(getNotificationAvatar()).toBeNull();
  });

  test("does no canvas work and holds nothing in a pop-out thread window", async () => {
    popoutWindow = true;

    render();

    await waitFor(() => {
      expect(rasterizeNotificationAvatar).not.toHaveBeenCalled();
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

describe("the bytes the holder passes on", () => {
  test("fit what the IPC boundary accepts", () => {
    expect(NOTIFICATION_AVATAR_BASE64_MAX_CHARS).toBe(
      Math.ceil(NOTIFICATION_AVATAR_MAX_LOCAL_BYTES / 3) * 4,
    );
  });
});
