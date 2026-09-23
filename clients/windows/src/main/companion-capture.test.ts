import { beforeEach, expect, mock, test } from "bun:test";

const capture = mock(async () => [
  {
    id: "screen:4:0",
    display_id: "42",
    thumbnail: {
      isEmpty: () => false,
      getSize: () => ({ width: 1000, height: 600 }),
      toJPEG: () => Buffer.from("frame"),
    },
  },
]);
const helperCall = mock(
  async (_method: string, _params?: unknown): Promise<unknown> => ({
    windows: [],
  }),
);
const toDip = mock(
  (
    _window: unknown,
    rect: { x: number; y: number; width: number; height: number },
  ) => ({
    x: rect.x / 2,
    y: rect.y / 2,
    width: rect.width / 2,
    height: rect.height / 2,
  }),
);
mock.module("electron", () => ({
  app: {},
  desktopCapturer: { getSources: capture },
  screen: {
    screenToDipRect: toDip,
    getAllDisplays: () => [
      { id: 42, bounds: { x: 0, y: 0, width: 1000, height: 600 } },
    ],
  },
}));
mock.module("./features/computer-use-actions", () => ({
  getSharedCuHelper: () => ({ call: helperCall }),
}));
const { callCompanionCapture } = await import("./companion-capture");
beforeEach(() => {
  capture.mockClear();
  helperCall.mockClear();
  toDip.mockClear();
});

test("maps Electron display identifiers without substituting another display", async () => {
  expect(
    await callCompanionCapture("capture.frame", {
      displayId: 42,
      maxWidth: 1600,
      maxHeight: 1000,
    }),
  ).toEqual({
    jpegBase64: Buffer.from("frame").toString("base64"),
    width: 1000,
    height: 600,
  });
  await expect(
    callCompanionCapture("capture.frame", {
      displayId: 7,
      maxWidth: 1600,
      maxHeight: 1000,
    }),
  ).rejects.toThrow("unavailable");
});

test("filters host windows and translates native physical bounds to Electron coordinates", async () => {
  const window = {
    windowId: 7,
    pid: 123,
    app: "Example",
    title: "Document",
    bounds: { x: -1200, y: 100, width: 800, height: 600 },
  };
  helperCall.mockResolvedValueOnce({
    windows: [window, { ...window, windowId: 8, pid: process.pid }],
  });
  expect(await callCompanionCapture("captureSources.list")).toEqual({
    windows: [
      { ...window, bounds: { x: -600, y: 50, width: 400, height: 300 } },
    ],
  });
});

test("converts accessibility rectangles to the same coordinate space as the shared frame", async () => {
  helperCall.mockResolvedValueOnce({
    found: true,
    label: "Save",
    role: "button",
    x: -1200,
    y: 100,
    width: 80,
    height: 40,
  });
  expect(
    await callCompanionCapture("ax.locate", { windowId: 7, query: "Save" }),
  ).toEqual({
    found: true,
    label: "Save",
    role: "button",
    x: -600,
    y: 50,
    width: 40,
    height: 20,
  });
});

test("locates on the shared display when the foreground window is on another monitor", async () => {
  const window = {
    windowId: 7,
    pid: 123,
    app: "Example",
    title: "Calculator",
    onScreen: true,
    bounds: { x: 100, y: 100, width: 800, height: 600 },
  };
  helperCall.mockResolvedValueOnce({
    windows: [
      { ...window, windowId: 9, pid: process.pid },
      { ...window, windowId: 8, bounds: { ...window.bounds, x: -1200 } },
      window,
    ],
  });
  helperCall.mockResolvedValueOnce({ found: false, reason: "no-match" });
  await callCompanionCapture("ax.locate", { displayId: 42, query: "7" });
  expect(helperCall).toHaveBeenLastCalledWith("ax.locate", {
    displayId: 42,
    query: "7",
    windowId: 7,
  });
});

test("does not read a covered window behind one that straddles the shared display", async () => {
  const window = {
    windowId: 7,
    pid: 123,
    app: "Example",
    title: "Document",
    onScreen: true,
    bounds: { x: -100, y: 100, width: 800, height: 600 },
  };
  helperCall.mockResolvedValueOnce({
    windows: [
      window,
      { ...window, windowId: 8, bounds: { ...window.bounds, x: 100 } },
    ],
  });
  expect(
    await callCompanionCapture("ax.locate", { displayId: 42, query: "Save" }),
  ).toEqual({ found: false, reason: "no-tree" });
  expect(helperCall).toHaveBeenCalledTimes(1);
});
