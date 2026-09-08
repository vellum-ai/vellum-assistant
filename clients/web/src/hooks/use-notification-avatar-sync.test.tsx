/**
 * The gate this hook exists to hold: the notification avatar is composited and
 * held only on Electron with `push-avatar-sender` on. Every other host, and the
 * flag off, must leave the holder empty so the IPC payload stays what it is
 * today, and a flag that turns off has to take back what an earlier run stored.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const AVATAR_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

let electronHost = true;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => electronHost,
}));

let rasterized: Uint8Array | null = AVATAR_PNG;
const rasterizeNotificationAvatar = mock(
  async (_src: string, _accentHex: string | null) => rasterized,
);
mock.module("@/utils/avatar-raster", () => ({ rasterizeNotificationAvatar }));

const { clearNotificationAvatar, getNotificationAvatar, sha256Hex } =
  await import("@/runtime/notification-avatar");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");
const { useNotificationAvatarSync } =
  await import("@/hooks/use-notification-avatar-sync");

const IMAGE_URL = "blob:avatar-1";
const ACCENT = "#E9642F";

const render = (accentHex: string | null = ACCENT) =>
  renderHook(() => useNotificationAvatarSync(IMAGE_URL, null, null, accentHex));

beforeEach(() => {
  electronHost = true;
  rasterized = AVATAR_PNG;
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
  test("holds the composited avatar and its hash on Electron with the flag on", async () => {
    render();

    await waitFor(() => {
      expect(getNotificationAvatar()).not.toBeNull();
    });
    expect(rasterizeNotificationAvatar).toHaveBeenCalledWith(IMAGE_URL, ACCENT);
    expect(getNotificationAvatar()).toEqual({
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

  test("holds nothing for an assistant with no avatar to draw", async () => {
    renderHook(() => useNotificationAvatarSync(null, null, null, ACCENT));

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
});
