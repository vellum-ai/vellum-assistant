import { describe, expect, test } from "bun:test";

import { toDisplayAttachments } from "@/utils/display-attachments";

describe("toDisplayAttachments", () => {
  test("returns undefined for empty/missing input", () => {
    expect(toDisplayAttachments(undefined)).toBeUndefined();
    expect(toDisplayAttachments([])).toBeUndefined();
  });

  test("converts image attachment with data-URI previewUrl", () => {
    const result = toDisplayAttachments([
      {
        id: "att-1",
        filename: "photo.png",
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
      },
    ]);
    expect(result).toEqual([
      {
        id: "att-1",
        filename: "photo.png",
        mimeType: "image/png",
        sizeBytes: expect.any(Number),
        previewUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
    ]);
  });

  test("creates data-URI previewUrl for non-image types with inline data", () => {
    const result = toDisplayAttachments([
      {
        id: "att-2",
        filename: "report.pdf",
        mimeType: "application/pdf",
        data: "JVBERi0xLjQ=",
      },
    ]);
    expect(result).toEqual([
      {
        id: "att-2",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: expect.any(Number),
        previewUrl: "data:application/pdf;base64,JVBERi0xLjQ=",
      },
    ]);
  });

  test("video with empty data uses thumbnail as thumbnailUrl, not previewUrl", () => {
    const result = toDisplayAttachments([
      {
        id: "att-3",
        filename: "clip.mp4",
        mimeType: "video/mp4",
        data: "",
        thumbnailData: "thumb123",
        fileBacked: true,
        sizeBytes: 1024,
      },
    ]);
    expect(result).toEqual([
      {
        id: "att-3",
        filename: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1024,
        previewUrl: null,
        thumbnailUrl: "data:image/jpeg;base64,thumb123",
      },
    ]);
  });

  test("video with inline data still gets null previewUrl (Electron CSP fix)", () => {
    const result = toDisplayAttachments([
      {
        id: "att-small",
        filename: "small.mp4",
        mimeType: "video/mp4",
        data: "AAAAIGZ0cg==",
        thumbnailData: "thumb456",
        sizeBytes: 100,
      },
    ]);
    // previewUrl must be null even with inline data — the Electron CSP
    // media-src directive allows blob: but not data:, so a data:video URI
    // would be CSP-blocked. The modal's lazy-fetch path creates a blob URL.
    expect(result).toEqual([
      {
        id: "att-small",
        filename: "small.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
        previewUrl: null,
        thumbnailUrl: "data:image/jpeg;base64,thumb456",
      },
    ]);
  });

  test("falls back to filename for id when id is missing", () => {
    const result = toDisplayAttachments([
      {
        filename: "noId.txt",
        mimeType: "text/plain",
        data: "aGVsbG8=",
      },
    ]);
    expect(result?.[0]?.id).toBe("noId.txt");
  });
});
