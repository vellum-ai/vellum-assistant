import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

let isElectronMock = false;
let inlineTitleBarActiveMock = false;

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => isElectronMock,
}));

mock.module("@/stores/title-bar-store", () => ({
  useTitleBarStore: {
    use: { inlineTitleBarActive: () => inlineTitleBarActiveMock },
  },
}));

import { WindowDragRegion } from "@/components/window-drag-region";

beforeEach(() => {
  isElectronMock = false;
  inlineTitleBarActiveMock = false;
});

describe("WindowDragRegion", () => {
  test("renders nothing off Electron", () => {
    isElectronMock = false;
    expect(renderToStaticMarkup(<WindowDragRegion />)).toBe("");
  });

  test("renders the drag strip on Electron when no inline title bar is active", () => {
    isElectronMock = true;
    const html = renderToStaticMarkup(<WindowDragRegion />);
    expect(html).toContain("app-region:drag");
  });

  test("yields while an inline title bar (the chat header) owns dragging", () => {
    // The chat header is the macOS title bar on the main app and provides its
    // own drag region; the fallback strip must step aside so it doesn't
    // out-stack and swallow the header's button clicks.
    isElectronMock = true;
    inlineTitleBarActiveMock = true;
    expect(renderToStaticMarkup(<WindowDragRegion />)).toBe("");
  });
});
