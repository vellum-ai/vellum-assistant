import { afterEach, describe, expect, test } from "bun:test";

import {
  IMAGE_AUTO_RESIZE_TARGET_BYTES,
  filenameForResizedImage,
  isAutoResizableImage,
  prepareImageAttachmentForUpload,
  shouldAutoResizeImageAttachment,
} from "@/components/app/assistant/ChatAttachments/attachment-image-resize.js";

const originalCreateImageBitmap = globalThis.createImageBitmap;
const originalDocument = globalThis.document;

afterEach(() => {
  if (originalCreateImageBitmap) {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: originalCreateImageBitmap,
    });
  } else {
    Reflect.deleteProperty(globalThis, "createImageBitmap");
  }

  if (originalDocument) {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  } else {
    Reflect.deleteProperty(globalThis, "document");
  }
});

describe("attachment image resizing", () => {
  test("recognizes candidate photo formats but not animated GIFs", () => {
    expect(isAutoResizableImage(new File([], "photo.jpeg", { type: "image/jpeg" }))).toBe(true);
    expect(isAutoResizableImage(new File([], "photo.HEIC", { type: "" }))).toBe(true);
    expect(isAutoResizableImage(new File([], "animated.gif", { type: "image/gif" }))).toBe(false);
  });

  test("only resizes recognized images above the transport target", () => {
    const smallPhoto = new File([new Uint8Array(1024)], "small.jpg", { type: "image/jpeg" });
    const largePhoto = new File(
      [new Uint8Array(IMAGE_AUTO_RESIZE_TARGET_BYTES + 1)],
      "large.jpg",
      { type: "image/jpeg" },
    );
    const largePdf = new File(
      [new Uint8Array(IMAGE_AUTO_RESIZE_TARGET_BYTES + 1)],
      "large.pdf",
      { type: "application/pdf" },
    );

    expect(shouldAutoResizeImageAttachment(smallPhoto)).toBe(false);
    expect(shouldAutoResizeImageAttachment(largePhoto)).toBe(true);
    expect(shouldAutoResizeImageAttachment(largePdf)).toBe(false);
  });

  test("uses a JPEG filename when an image is transcoded", () => {
    expect(filenameForResizedImage("IMG_9292.jpeg")).toBe("IMG_9292.jpeg");
    expect(filenameForResizedImage("screenshot.png")).toBe("screenshot.jpg");
    expect(filenameForResizedImage("")).toBe("attachment.jpg");
  });

  test("compresses an oversized image to a provider-safe JPEG", async () => {
    const canvases = installMockImageEncoder({
      width: 4032,
      height: 3024,
      outputSizes: [IMAGE_AUTO_RESIZE_TARGET_BYTES + 20_000, IMAGE_AUTO_RESIZE_TARGET_BYTES - 20_000],
    });
    const file = new File(
      [new Uint8Array(IMAGE_AUTO_RESIZE_TARGET_BYTES + 100_000)],
      "capture.png",
      { type: "image/png", lastModified: 1234 },
    );

    const result = await prepareImageAttachmentForUpload(file);

    expect(result.status).toBe("resized");
    if (result.status !== "resized") {
      return;
    }

    expect(result.file.name).toBe("capture.jpg");
    expect(result.file.type).toBe("image/jpeg");
    expect(result.file.size).toBeLessThanOrEqual(IMAGE_AUTO_RESIZE_TARGET_BYTES);
    expect(result.file.lastModified).toBe(1234);
    expect(canvases[0]?.encodedWidth).toBe(4032);
    expect(canvases[0]?.encodedHeight).toBe(3024);
    expect(canvases[0]?.width).toBe(0);
    expect(canvases[0]?.height).toBe(0);
  });

  test("preserves animated WebP instead of flattening it through canvas", async () => {
    installMockImageEncoder({
      width: 1280,
      height: 720,
      outputSizes: [IMAGE_AUTO_RESIZE_TARGET_BYTES - 20_000],
    });
    const header = new Uint8Array(64);
    writeAscii(header, 0, "RIFF");
    writeAscii(header, 8, "WEBP");
    writeAscii(header, 12, "VP8X");
    header[20] = 0x02;
    const file = new File([header, new Uint8Array(IMAGE_AUTO_RESIZE_TARGET_BYTES + 1)], "clip.webp", {
      type: "image/webp",
    });

    const result = await prepareImageAttachmentForUpload(file);

    expect(result).toEqual({ status: "unchanged", file });
  });

  test("fails locally when the browser encoder cannot shrink an oversized image", async () => {
    installMockImageEncoder({
      width: 4032,
      height: 3024,
      outputSizes: [
        IMAGE_AUTO_RESIZE_TARGET_BYTES + 200_000,
        IMAGE_AUTO_RESIZE_TARGET_BYTES + 150_000,
        IMAGE_AUTO_RESIZE_TARGET_BYTES + 100_000,
        IMAGE_AUTO_RESIZE_TARGET_BYTES + 50_000,
      ],
    });
    const file = new File(
      [new Uint8Array(IMAGE_AUTO_RESIZE_TARGET_BYTES + 100_000)],
      "capture.jpg",
      { type: "image/jpeg" },
    );

    const result = await prepareImageAttachmentForUpload(file);

    expect(result.status).toBe("failed");
  });
});

function installMockImageEncoder({
  width,
  height,
  outputSizes,
}: {
  width: number;
  height: number;
  outputSizes: number[];
}): Array<{ width: number; height: number; encodedWidth: number | null; encodedHeight: number | null }> {
  const canvases: Array<{
    width: number;
    height: number;
    encodedWidth: number | null;
    encodedHeight: number | null;
  }> = [];
  const sizes = [...outputSizes];

  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => ({
      width,
      height,
      close: () => undefined,
    }),
  });

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tagName: string) => {
        expect(tagName).toBe("canvas");
        const canvas = {
          width: 0,
          height: 0,
          encodedWidth: null as number | null,
          encodedHeight: null as number | null,
          getContext: (contextType: string) => {
            expect(contextType).toBe("2d");
            return {
              fillStyle: "",
              fillRect: () => undefined,
              drawImage: () => undefined,
            };
          },
          toBlob: (
            callback: (blob: Blob | null) => void,
            mimeType: string,
            _quality?: number,
          ) => {
            canvas.encodedWidth = canvas.width;
            canvas.encodedHeight = canvas.height;
            const size = sizes.shift() ?? outputSizes[outputSizes.length - 1] ?? 1;
            callback(new Blob([new Uint8Array(size)], { type: mimeType }));
          },
        };
        canvases.push(canvas);
        return canvas;
      },
    },
  });

  return canvases;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}
