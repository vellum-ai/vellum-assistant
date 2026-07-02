/**
 * Tests for the pure attachment-preparation gates. The async conversion path
 * needs a real browser image decoder (canvas/createImageBitmap), so it is not
 * exercised here.
 */
import { describe, expect, test } from "bun:test";

import {
  filenameForResizedImage,
  IMAGE_AUTO_RESIZE_TARGET_BYTES,
  isHeicAttachment,
  shouldAutoResizeImageAttachment,
  shouldPrepareImageAttachment,
} from "@/domains/chat/components/chat-attachments/attachment-image-resize";

const SMALL = 100 * 1024;
const LARGE = IMAGE_AUTO_RESIZE_TARGET_BYTES + 1;

describe("isHeicAttachment", () => {
  test("matches by mime type", () => {
    expect(isHeicAttachment({ name: "photo", type: "image/heic" })).toBe(true);
    expect(isHeicAttachment({ name: "photo", type: "image/heif" })).toBe(true);
    expect(isHeicAttachment({ name: "photo.png", type: "image/png" })).toBe(false);
  });

  test("matches by extension when the mime type is missing", () => {
    // Chromium reports an empty file.type for .heic files.
    expect(isHeicAttachment({ name: "IMG_5487.HEIC", type: "" })).toBe(true);
    expect(isHeicAttachment({ name: "photo.heif", type: "" })).toBe(true);
    expect(isHeicAttachment({ name: "photo.jpg", type: "" })).toBe(false);
    expect(isHeicAttachment({ name: "myheic.png", type: "" })).toBe(false);
  });
});

describe("shouldPrepareImageAttachment", () => {
  test("HEIC is prepared regardless of size (compatibility conversion)", () => {
    expect(
      shouldPrepareImageAttachment({
        name: "IMG_5487.HEIC",
        type: "image/heic",
        size: SMALL,
      }),
    ).toBe(true);
  });

  test("non-HEIC images keep the size gate", () => {
    const smallPng = { name: "a.png", type: "image/png", size: SMALL };
    const largePng = { name: "a.png", type: "image/png", size: LARGE };
    expect(shouldPrepareImageAttachment(smallPng)).toBe(false);
    expect(shouldPrepareImageAttachment(largePng)).toBe(true);
    expect(shouldAutoResizeImageAttachment(smallPng)).toBe(false);
  });

  test("non-image files are never prepared", () => {
    expect(
      shouldPrepareImageAttachment({
        name: "report.pdf",
        type: "application/pdf",
        size: LARGE,
      }),
    ).toBe(false);
  });
});

describe("filenameForResizedImage", () => {
  test("rewrites the extension to .jpg", () => {
    expect(filenameForResizedImage("IMG_5487.HEIC")).toBe("IMG_5487.jpg");
    expect(filenameForResizedImage("photo.png")).toBe("photo.jpg");
  });

  test("keeps existing jpeg extensions", () => {
    expect(filenameForResizedImage("photo.jpg")).toBe("photo.jpg");
    expect(filenameForResizedImage("photo.JPEG")).toBe("photo.JPEG");
  });
});
