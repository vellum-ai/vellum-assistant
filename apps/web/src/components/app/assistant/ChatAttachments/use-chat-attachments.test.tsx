import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { IMAGE_AUTO_RESIZE_TARGET_BYTES } from "@/components/app/assistant/ChatAttachments/attachment-image-resize.js";

const uploadedFiles: File[] = [];

mock.module("@/domains/chat/lib/api", () => ({
  uploadChatAttachment: async (_assistantId: string, file: File) => {
    uploadedFiles.push(file);
    return { ok: true as const, id: `uploaded-${uploadedFiles.length}` };
  },
}));

import { useChatAttachments } from "@/components/app/assistant/ChatAttachments/use-chat-attachments.js";

const originalCreateImageBitmap = globalThis.createImageBitmap;
const originalImage = globalThis.Image;

beforeEach(() => {
  uploadedFiles.length = 0;
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => {
      throw new Error("decode failed");
    },
  });
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  cleanup();
  if (originalCreateImageBitmap) {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: originalCreateImageBitmap,
    });
  } else {
    Reflect.deleteProperty(globalThis, "createImageBitmap");
  }
  if (originalImage) {
    Object.defineProperty(globalThis, "Image", {
      configurable: true,
      value: originalImage,
    });
  } else {
    Reflect.deleteProperty(globalThis, "Image");
  }
});

describe("useChatAttachments", () => {
  test("falls back to uploading the original under-50 MB file when image resizing fails", async () => {
    const file = new File(
      [new Uint8Array(IMAGE_AUTO_RESIZE_TARGET_BYTES + 1)],
      "chrome-heic.jpg",
      { type: "image/jpeg" },
    );
    const { result } = renderHook(() => useChatAttachments("assistant-1"));

    act(() => {
      result.current.addFiles([file]);
    });

    await waitFor(() => expect(uploadedFiles).toHaveLength(1));

    expect(uploadedFiles[0]).toBe(file);
    await waitFor(() => expect(result.current.attachments[0]?.kind).toBe("uploaded"));
    expect(result.current.attachments[0]).toMatchObject({
      kind: "uploaded",
      filename: "chrome-heic.jpg",
      sizeBytes: file.size,
    });
  });
});
