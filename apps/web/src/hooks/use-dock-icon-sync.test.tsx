import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

// The hook is Electron-only and rasterizes avatar art on a canvas before
// pushing it to the host. Drive both seams from mutable doubles: toggle
// `electron`, stub the rasterizers to deterministic data URLs, and capture
// the host calls.
let electron = true;
const setDockIconMock = mock((_dataUrl: string | null) => Promise.resolve());
const composeSvgMock = mock(
  (
    _components: unknown,
    _body: string,
    _eye: string,
    _color: string,
    _size: number,
  ) => "<svg/>",
);
const rasterizeSvgMock = mock((_svg: string, _size: number) =>
  Promise.resolve("data:image/png;base64,CHARACTER"),
);
const rasterizeImageMock = mock((_src: string, _size: number) =>
  Promise.resolve("data:image/png;base64,IMAGE"),
);

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => electron,
}));

mock.module("@/runtime/dock", () => ({
  setDockIcon: setDockIconMock,
}));

mock.module("@/utils/avatar-svg-compositor", () => ({
  composeSvg: composeSvgMock,
}));

mock.module("@/lib/rasterize", () => ({
  rasterizeSvgToPng: rasterizeSvgMock,
  rasterizeImageToPng: rasterizeImageMock,
}));

const { useDockIconSync, selectDockIconSource } = await import(
  "@/hooks/use-dock-icon-sync"
);

const COMPONENTS = {
  bodyShapes: [],
  eyeStyles: [],
  colors: [],
  faceCenterOverrides: [],
} as CharacterComponents;
const TRAITS: CharacterTraits = {
  bodyShape: "round",
  eyeStyle: "happy",
  color: "forest",
};

beforeEach(() => {
  electron = true;
  setDockIconMock.mockClear();
  composeSvgMock.mockClear();
  composeSvgMock.mockImplementation(() => "<svg/>");
  rasterizeSvgMock.mockClear();
  rasterizeImageMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("selectDockIconSource", () => {
  test("prefers character traits over a custom image", () => {
    const source = selectDockIconSource("blob:custom", COMPONENTS, TRAITS);
    expect(source).toEqual({ kind: "character", svg: "<svg/>" });
  });

  test("falls back to the custom image when there are no traits", () => {
    expect(selectDockIconSource("blob:custom", COMPONENTS, null)).toEqual({
      kind: "image",
      url: "blob:custom",
    });
  });

  test("reports 'none' when there is neither traits nor an image", () => {
    expect(selectDockIconSource(null, COMPONENTS, null)).toEqual({
      kind: "none",
    });
    expect(selectDockIconSource(null, null, TRAITS)).toEqual({ kind: "none" });
  });

  test("falls through to image/none when composeSvg throws on bad IDs", () => {
    composeSvgMock.mockImplementation(() => {
      throw new Error("unknown trait id");
    });
    expect(selectDockIconSource("blob:custom", COMPONENTS, TRAITS)).toEqual({
      kind: "image",
      url: "blob:custom",
    });
    expect(selectDockIconSource(null, COMPONENTS, TRAITS)).toEqual({
      kind: "none",
    });
  });
});

describe("useDockIconSync", () => {
  test("pushes the rasterized character avatar to the Dock", async () => {
    renderHook(() => useDockIconSync(null, COMPONENTS, TRAITS));
    await waitFor(() =>
      expect(setDockIconMock).toHaveBeenCalledWith(
        "data:image/png;base64,CHARACTER",
      ),
    );
    expect(rasterizeSvgMock).toHaveBeenCalled();
    expect(rasterizeImageMock).not.toHaveBeenCalled();
  });

  test("pushes the rasterized custom image when there are no traits", async () => {
    renderHook(() => useDockIconSync("blob:custom", COMPONENTS, null));
    await waitFor(() =>
      expect(setDockIconMock).toHaveBeenCalledWith(
        "data:image/png;base64,IMAGE",
      ),
    );
    expect(rasterizeImageMock).toHaveBeenCalledWith("blob:custom", 512);
  });

  test("resets to the default icon (null) when there is no avatar", async () => {
    renderHook(() => useDockIconSync(null, null, null));
    await waitFor(() => expect(setDockIconMock).toHaveBeenCalledWith(null));
    expect(rasterizeSvgMock).not.toHaveBeenCalled();
    expect(rasterizeImageMock).not.toHaveBeenCalled();
  });

  test("resets to the default icon on unmount", async () => {
    const { unmount } = renderHook(() =>
      useDockIconSync(null, COMPONENTS, TRAITS),
    );
    await waitFor(() => expect(setDockIconMock).toHaveBeenCalled());
    setDockIconMock.mockClear();
    unmount();
    expect(setDockIconMock).toHaveBeenCalledWith(null);
  });

  test("does nothing off Electron — no rasterization, no host calls", async () => {
    electron = false;
    renderHook(() => useDockIconSync(null, COMPONENTS, TRAITS));
    // Give any (incorrectly scheduled) async work a chance to run.
    await Promise.resolve();
    expect(rasterizeSvgMock).not.toHaveBeenCalled();
    expect(setDockIconMock).not.toHaveBeenCalled();
  });
});
