import { beforeEach, describe, expect, mock, test } from "bun:test";

// `./status` transitively imports `./ipc` (→ `ipcMain`) at module load; stub
// it so this test only needs the `nativeImage` surface, mocked below.
mock.module("./ipc", () => ({ on: () => undefined, handle: () => undefined }));

const setTemplateImageMock = mock((_flag: boolean) => undefined);
const createFromBitmapMock = mock((_buf: unknown, _opts: unknown) => ({
  setTemplateImage: setTemplateImageMock,
}));
// 36px (18pt @2x) BGRA canvas, matching the module's render size.
const CANVAS_PX = 36;
const toBitmapMock = mock(() => Buffer.alloc(CANVAS_PX * CANVAS_PX * 4));
const resizeMock = mock((_opts: unknown) => ({ toBitmap: toBitmapMock }));
const createFromBufferMock = mock((_buf: unknown) => ({ resize: resizeMock }));

// `getSystemColor` returns a fixed `#RRGGBBAA` so `statusColor` exercises its
// live-color parse path deterministically; the dot tests pass the resolved
// color explicitly, so a single value across statuses keeps them consistent.
const getSystemColorMock = mock((_name: string) => "#34c759ff");

mock.module("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  nativeImage: {
    createFromBuffer: createFromBufferMock,
    createFromBitmap: createFromBitmapMock,
  },
  systemPreferences: {
    getSystemColor: getSystemColorMock,
  },
}));

const {
  buildStatusIcon,
  compositeStatusDot,
  statusColor,
  statusFrames,
  __resetForTesting,
} = await import("./status-icon");
const { PULSE_FRAME_COUNT } = await import("./status");

const px = (bitmap: Buffer, x: number, y: number): number[] => {
  const offset = (y * CANVAS_PX + x) * 4;
  return [
    bitmap[offset + 0]!,
    bitmap[offset + 1]!,
    bitmap[offset + 2]!,
    bitmap[offset + 3]!,
  ];
};

beforeEach(() => {
  __resetForTesting();
  setTemplateImageMock.mockClear();
  createFromBitmapMock.mockClear();
  createFromBufferMock.mockClear();
  resizeMock.mockClear();
  toBitmapMock.mockClear();
});

describe("compositeStatusDot", () => {
  test("fills the dot center with the status color (BGRA) at full alpha", () => {
    const bitmap = Buffer.alloc(CANVAS_PX * CANVAS_PX * 4);
    const green = statusColor("thinking");
    compositeStatusDot(bitmap, CANVAS_PX, green, 1);
    // Dot center sits inset from the bottom-right corner (margin + radius).
    const [b, g, r, a] = px(bitmap, 28, 28);
    expect(a).toBe(255);
    expect(b).toBe(green.b);
    expect(g).toBe(green.g);
    expect(r).toBe(green.r);
  });

  test("leaves the opposite (top-left) corner untouched", () => {
    const bitmap = Buffer.alloc(CANVAS_PX * CANVAS_PX * 4);
    compositeStatusDot(bitmap, CANVAS_PX, statusColor("error"), 1);
    expect(px(bitmap, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  test("strokes a semi-transparent dark ring around the fill", () => {
    const bitmap = Buffer.alloc(CANVAS_PX * CANVAS_PX * 4);
    compositeStatusDot(bitmap, CANVAS_PX, statusColor("idle"), 1);
    // A pixel in the ring annulus (outside the 4px fill radius, inside the
    // 6px outer radius) is dark at ~0.5 alpha.
    const [b, g, r, a] = px(bitmap, 33, 28);
    expect(b).toBe(0);
    expect(g).toBe(0);
    expect(r).toBe(0);
    expect(a).toBeGreaterThan(100);
    expect(a).toBeLessThan(160);
  });

  test("opacity 0 is a no-op so a fully-faded pulse frame shows only the glyph", () => {
    const bitmap = Buffer.alloc(CANVAS_PX * CANVAS_PX * 4);
    compositeStatusDot(bitmap, CANVAS_PX, statusColor("thinking"), 0);
    expect(px(bitmap, 28, 28)).toEqual([0, 0, 0, 0]);
  });
});

describe("buildStatusIcon", () => {
  test("renders a 2x non-template image", () => {
    buildStatusIcon("idle");
    expect(setTemplateImageMock).toHaveBeenCalledWith(false);
    const opts = createFromBitmapMock.mock.calls[0]?.[1] as {
      width: number;
      height: number;
      scaleFactor: number;
    };
    expect(opts.width).toBe(CANVAS_PX);
    expect(opts.height).toBe(CANVAS_PX);
    expect(opts.scaleFactor).toBe(2);
  });

  test("decodes and resizes the brand glyph only once across frames", () => {
    buildStatusIcon("idle");
    buildStatusIcon("error");
    expect(createFromBufferMock).toHaveBeenCalledTimes(1);
    expect(resizeMock).toHaveBeenCalledTimes(1);
  });
});

describe("statusFrames", () => {
  test("static states render a single frame, thinking renders the full pulse cycle", () => {
    expect(statusFrames("idle")).toHaveLength(1);
    expect(statusFrames("disconnected")).toHaveLength(1);
    expect(statusFrames("thinking")).toHaveLength(PULSE_FRAME_COUNT);
  });

  test("frames are cached per status", () => {
    const first = statusFrames("thinking");
    const second = statusFrames("thinking");
    expect(second).toBe(first);
  });
});
