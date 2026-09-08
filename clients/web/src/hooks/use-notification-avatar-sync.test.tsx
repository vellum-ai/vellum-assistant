/**
 * The gate this hook exists to hold: the notification avatar is composited and
 * held only on Electron with `push-avatar-sender` on. Every other host, and the
 * flag off, must leave the holder empty so the IPC payload carries no `sender`
 * field, and a flag that turns off, or a hook that goes away, has to take back
 * what an earlier run stored. What is held is stamped with the assistant it was
 * drawn for, and a replacement render empties the holder before it starts
 * drawing.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const AVATAR_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

let electronHost = true;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => electronHost,
}));

let rasterized: Uint8Array | null = AVATAR_PNG;
/** Set to stall the rasterizer so the mid-render window can be observed. */
let rasterizeGate: Promise<void> | null = null;
const rasterizeNotificationAvatar = mock(
  async (_src: string, _accentHex: string | null) => {
    if (rasterizeGate) {
      await rasterizeGate;
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

const render = (accentHex: string | null = ACCENT) =>
  renderHook(() =>
    useNotificationAvatarSync(ASSISTANT_ID, IMAGE_URL, null, null, accentHex),
  );

beforeEach(() => {
  electronHost = true;
  rasterized = AVATAR_PNG;
  rasterizeGate = null;
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
      useNotificationAvatarSync(ASSISTANT_ID, null, null, null, ACCENT),
    );

    await waitFor(() => {
      expect(rasterizeNotificationAvatar).not.toHaveBeenCalled();
    });
    expect(getNotificationAvatar()).toBeNull();
  });

  test("holds nothing while there is no active assistant", async () => {
    renderHook(() =>
      useNotificationAvatarSync(null, IMAGE_URL, null, null, ACCENT),
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

  test("empties the holder before drawing a replacement, then holds the new assistant's avatar", async () => {
    const { rerender } = renderHook(
      ({ id, url }: { id: string; url: string }) =>
        useNotificationAvatarSync(id, url, null, null, ACCENT),
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
});
