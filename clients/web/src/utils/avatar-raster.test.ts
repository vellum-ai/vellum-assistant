import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  coverCropSquare,
  rasterizeNotificationAvatar,
} from "@/utils/avatar-raster";
import {
  NOTIFICATION_AVATAR_INSET,
  NOTIFICATION_AVATAR_SIZE,
  notificationAvatarDiscHex,
} from "@vellumai/avatar-manifest/notification-avatar";

// Locks `object-cover` parity for every rasterized avatar surface
// (Dock/menu-bar icons, the iOS Live Activity): a non-square avatar
// must be center-cropped to a square (not stretched), matching the in-app
// `ChatAvatar`. Regressed when the rasterizer used a 4-arg `drawImage` that
// stretched the source to fill the square canvas.
describe("coverCropSquare", () => {
  test("returns the full image unchanged for a square source", () => {
    expect(coverCropSquare(512, 512)).toEqual({ sx: 0, sy: 0, side: 512 });
  });

  test("crops the horizontal center of a landscape source", () => {
    // 200×100 → 100px square centered horizontally (50px trimmed each side).
    expect(coverCropSquare(200, 100)).toEqual({ sx: 50, sy: 0, side: 100 });
  });

  test("crops the vertical center of a portrait source", () => {
    // 100×200 → 100px square centered vertically (50px trimmed top/bottom).
    expect(coverCropSquare(100, 200)).toEqual({ sx: 0, sy: 50, side: 100 });
  });

  test("returns null for a degenerate (zero-dimension) source", () => {
    expect(coverCropSquare(0, 100)).toBeNull();
    expect(coverCropSquare(100, 0)).toBeNull();
    expect(coverCropSquare(0, 0)).toBeNull();
  });
});

/**
 * The notification avatar's disc, drawn through a stand-in canvas.
 *
 * happy-dom hands back no 2D context, so there are no pixels to sample here:
 * the corner cannot be read as transparent directly, and the circular clip the
 * drawing passes through is what stands in for it. The clip has to match the
 * disc the SVG in `@vellumai/avatar-manifest` is clipped to, so an avatar whose
 * subject runs to its own edges keeps the round silhouette on every platform.
 */
describe("rasterizeNotificationAvatar", () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const SOURCE = "data:image/svg+xml;base64,PHN2Zy8+";

  interface Arc {
    x: number;
    y: number;
    radius: number;
  }

  let ops: string[] = [];
  let arcs: Arc[] = [];
  let drawn: number[][] = [];
  let fills: string[] = [];
  let canvas: { width: number; height: number };
  let realCreateElement: typeof document.createElement;
  let realImage: typeof Image;

  beforeEach(() => {
    ops = [];
    arcs = [];
    drawn = [];
    fills = [];
    let fillStyle = "";
    const ctx = {
      clearRect: () => ops.push("clearRect"),
      beginPath: () => ops.push("beginPath"),
      arc: (x: number, y: number, radius: number) => {
        ops.push("arc");
        arcs.push({ x, y, radius });
      },
      fill: () => {
        ops.push("fill");
        fills.push(fillStyle);
      },
      save: () => ops.push("save"),
      clip: () => ops.push("clip"),
      restore: () => ops.push("restore"),
      drawImage: (_image: unknown, ...args: number[]) => {
        ops.push("drawImage");
        drawn.push(args);
      },
      get fillStyle(): string {
        return fillStyle;
      },
      set fillStyle(value: string) {
        fillStyle = value;
      },
    };
    canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      toBlob: (callback: (blob: Blob) => void) => {
        callback(new Blob([PNG_BYTES], { type: "image/png" }));
      },
    } as unknown as { width: number; height: number };

    realCreateElement = document.createElement;
    document.createElement = ((tag: string) =>
      tag === "canvas"
        ? canvas
        : realCreateElement.call(
            document,
            tag,
          )) as unknown as typeof document.createElement;

    realImage = globalThis.Image;
    globalThis.Image = class {
      naturalWidth = 512;
      naturalHeight = 512;
      onload: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    } as unknown as typeof Image;
  });

  afterEach(() => {
    document.createElement = realCreateElement;
    globalThis.Image = realImage;
  });

  test("draws the accent disc and the inset avatar through a full-circle clip", async () => {
    const bytes = await rasterizeNotificationAvatar(SOURCE, "#E9642F");

    expect(canvas.width).toBe(NOTIFICATION_AVATAR_SIZE);
    expect(canvas.height).toBe(NOTIFICATION_AVATAR_SIZE);
    expect(ops).toEqual([
      "clearRect",
      "beginPath",
      "arc",
      "fill",
      "save",
      "beginPath",
      "arc",
      "clip",
      "drawImage",
      "restore",
    ]);
    expect(fills).toEqual([notificationAvatarDiscHex("#E9642F")]);

    const radius = NOTIFICATION_AVATAR_SIZE / 2;
    const disc = { x: radius, y: radius, radius };
    // The clipped circle is the disc itself, so nothing lands outside it and
    // the square corners of the output stay untouched.
    expect(arcs).toEqual([disc, disc]);

    const inset = NOTIFICATION_AVATAR_SIZE * NOTIFICATION_AVATAR_INSET;
    const inner = NOTIFICATION_AVATAR_SIZE - 2 * inset;
    expect(drawn[0]?.slice(4)).toEqual([inset, inset, inner, inner]);
    expect(bytes && Array.from(bytes)).toEqual(Array.from(PNG_BYTES));
  });

  test("falls back to the neutral disc for an assistant with no accent", async () => {
    await rasterizeNotificationAvatar(SOURCE, null);

    expect(fills).toEqual([notificationAvatarDiscHex(null)]);
  });
});
