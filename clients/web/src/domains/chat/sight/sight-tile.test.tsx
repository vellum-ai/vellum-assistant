/**
 * The tile's ownership of the camera.
 *
 * The viewfinder is the capture's only on-screen control, so its lifetime has
 * to bound the hardware's: a tile that leaves the tree (the window crossing the
 * mobile breakpoint, a route out of the chat layout) takes the camera with it.
 * Everything here renders under `StrictMode`, which is the tree `main.tsx`
 * mounts, so the cleanup React simulates between its two mount passes is part
 * of what is being asserted.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";

import { fakeCameraStream } from "@/domains/chat/sight/sight.test-helper";
import {
  restoreMediaDevices,
  stubMediaDevices,
} from "@/domains/chat/voice/voice-room/voice-camera.test-helper";

// The store reaches the frame encoder through this module, which pulls the
// native camera bridge and the generated auth SDK in behind it. The tile needs
// none of that, and happy-dom cannot decode a frame to encode in any case.
mock.module("@/domains/chat/voice/voice-room/voice-camera", () => ({
  captureVideoFrame: async () => null,
}));

const { useSightStore } = await import("./sight-store");
const { SightTile } = await import("./sight-tile");

afterEach(() => {
  cleanup();
  useSightStore.getState().stop();
  restoreMediaDevices();
});

/** The tile in the tree the app actually mounts it under. */
function renderTile() {
  return render(
    <StrictMode>
      <SightTile />
    </StrictMode>,
  );
}

/** Open the camera the way the toggle does, and hand back its track spies. */
async function startCamera() {
  const camera = fakeCameraStream();
  stubMediaDevices(() => Promise.resolve(camera.stream));
  await act(async () => {
    await useSightStore.getState().start();
  });
  return camera;
}

const closeControl = () =>
  screen.queryByRole("button", { name: "Close camera" });

describe("SightTile", () => {
  test("unmounting with the camera on releases every track", async () => {
    const view = renderTile();
    const { stops } = await startCamera();

    expect(closeControl()).not.toBeNull();
    for (const stop of stops) {
      expect(stop).not.toHaveBeenCalled();
    }

    view.unmount();

    expect(useSightStore.getState().status).toBe("off");
    expect(useSightStore.getState().stream).toBeNull();
    for (const stop of stops) {
      expect(stop).toHaveBeenCalledTimes(1);
    }
  });

  test("unmounting with the camera off leaves the next start alone", async () => {
    const view = renderTile();
    expect(closeControl()).toBeNull();

    view.unmount();
    expect(useSightStore.getState().status).toBe("off");

    // A teardown with nothing running must not spend the store's acquire epoch
    // on a stop nobody asked for.
    const { stops } = await startCamera();

    expect(useSightStore.getState().status).toBe("on");
    for (const stop of stops) {
      expect(stop).not.toHaveBeenCalled();
    }
  });
});
