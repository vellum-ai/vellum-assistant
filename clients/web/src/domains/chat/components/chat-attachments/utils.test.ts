/**
 * The image test the vision gate reads, and the classifier every attachment
 * surface renders from.
 *
 * Files arriving from a native picker carry whatever type their provider
 * published, which on Android may be nothing at all, so a filter reading the
 * type alone would let an image reach a model that cannot see one.
 */

import { describe, expect, test } from "bun:test";

import {
  classifyAttachment,
  isImageAttachment,
} from "@/domains/chat/components/chat-attachments/utils";

describe("isImageAttachment", () => {
  test("reads a type that names an image", () => {
    expect(isImageAttachment({ name: "a.jpg", type: "image/jpeg" })).toBe(true);
    expect(isImageAttachment({ name: "a.gif", type: "image/gif" })).toBe(true);
  });

  test("falls back to the filename when no type is published", () => {
    // What an Android provider without OpenableColumns metadata hands back.
    for (const name of [
      "photo.jpg",
      "photo.JPEG",
      "shot.png",
      "animation.gif",
      "logo.svg",
      "modern.avif",
      "scan.tiff",
      "live.heic",
    ]) {
      expect(isImageAttachment({ name, type: "" })).toBe(true);
    }
  });

  test("covers image formats a canvas cannot downscale", () => {
    // The resize whitelist leaves these out because they cannot be redrawn,
    // which is a different question from whether they are images.
    expect(isImageAttachment({ name: "animation.gif", type: "" })).toBe(true);
    expect(isImageAttachment({ name: "logo.svg", type: "" })).toBe(true);
  });

  test("still reads the filename under a generic type", () => {
    expect(
      isImageAttachment({
        name: "photo.jpg",
        type: "application/octet-stream",
      }),
    ).toBe(true);
  });

  test("leaves everything else alone", () => {
    expect(isImageAttachment({ name: "notes.pdf", type: "" })).toBe(false);
    expect(isImageAttachment({ name: "clip.mp4", type: "video/mp4" })).toBe(
      false,
    );
    expect(isImageAttachment({ name: "noextension", type: "" })).toBe(false);
    expect(isImageAttachment({ name: "archive.zip", type: "" })).toBe(false);
  });
});

describe("classifyAttachment", () => {
  test("reads the declared type", () => {
    expect(classifyAttachment("image/jpeg", "photo.jpg")).toBe("image");
    expect(classifyAttachment("application/pdf", "report.pdf")).toBe("pdf");
  });

  test("reads the PDF types publishers use in place of application/pdf", () => {
    expect(classifyAttachment("application/x-pdf", "report.pdf")).toBe("pdf");
    expect(classifyAttachment("application/acrobat", "report.pdf")).toBe("pdf");
    expect(classifyAttachment("application/vnd.pdf", "report.pdf")).toBe("pdf");
    expect(classifyAttachment("text/x-pdf", "scan.PDF")).toBe("pdf");
    expect(classifyAttachment("text/pdf", "scan.pdf")).toBe("pdf");
  });

  test("falls back to the filename under a type that names nothing", () => {
    expect(classifyAttachment("application/octet-stream", "photo.jpg")).toBe(
      "image",
    );
    expect(classifyAttachment("", "photo.HEIC")).toBe("image");
    expect(classifyAttachment("", "photo.jpg ")).toBe("image");
    expect(classifyAttachment("application/octet-stream", "report.pdf")).toBe(
      "pdf",
    );
    // A dotless name has no extension to fall back to, so the whole name is
    // not read as one.
    expect(classifyAttachment("application/octet-stream", "pdf")).not.toBe(
      "pdf",
    );
  });

  test("keeps a declared type over the filename", () => {
    // A video the user named after an image format is still a video, and the
    // preview modal picks its branch from this answer.
    expect(classifyAttachment("video/mp4", "clip.gif")).toBe("video");
    expect(classifyAttachment("text/plain", "diagram.svg")).toBe("text");
    // The preview modal routes on this answer, so a text file named after a
    // PDF must not reach the PDF renderer.
    expect(classifyAttachment("text/plain", "notes.pdf")).toBe("text");
    expect(classifyAttachment("application/json", "data.pdf")).toBe("file");
    expect(
      classifyAttachment("application/pdf; charset=binary", "report.pdf"),
    ).toBe("pdf");
    expect(
      classifyAttachment(
        "application/octet-stream; charset=binary",
        "photo.jpg",
      ),
    ).toBe("image");
  });
});
