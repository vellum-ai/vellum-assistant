/**
 * The pickers' own conversion, which the sheet's tests mock away.
 *
 * The bytes arrive as base64 rather than being read from a URL: the cloud
 * shells run under a pathful `server.url`, and a cross-origin read of the
 * file scheme is answered with an `Access-Control-Allow-Origin` built from
 * that full URL, which no origin can match. Asking the plugin for the data is
 * the only path that works for every file, so these pin that it is asked for
 * and that the payload survives the trip.
 */

import { describe, expect, mock, test } from "bun:test";

let lastPickMediaOptions: unknown;
let lastPickFilesOptions: unknown;
let mockFiles: unknown[] = [];

mock.module("@capawesome/capacitor-file-picker", () => ({
  FilePicker: {
    pickMedia: (options: unknown) => {
      lastPickMediaOptions = options;
      return Promise.resolve({ files: mockFiles });
    },
    pickFiles: (options: unknown) => {
      lastPickFilesOptions = options;
      return Promise.resolve({ files: mockFiles });
    },
  },
}));

const { isPickerDismissal, pickFilesNative, pickMediaNative } =
  await import("@/domains/chat/components/chat-attachments/native-attachment-pickers");

describe("pickMediaNative", () => {
  test("asks for the data and rebuilds the file from it", async () => {
    // GIVEN a picked photo the plugin returns as base64
    mockFiles = [
      { data: btoa("hello bytes"), name: "shot.jpg", mimeType: "image/jpeg" },
    ];

    const files = await pickMediaNative();

    // THEN the data was requested. Without `readData` the payload is absent
    // and there is nothing to build a File from.
    expect(lastPickMediaOptions).toEqual({ readData: true });

    // AND the bytes survive the base64 round trip intact
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("shot.jpg");
    expect(files[0]?.type).toBe("image/jpeg");
    expect(await files[0]?.text()).toBe("hello bytes");
  });

  test("prefers a Blob when the web implementation supplies one", async () => {
    mockFiles = [
      {
        blob: new Blob(["from blob"], { type: "image/png" }),
        name: "web.png",
        mimeType: "image/png",
      },
    ];

    const files = await pickMediaNative();

    expect(await files[0]?.text()).toBe("from blob");
  });

  test("keeps the rest of a multi-select when one entry carries neither", async () => {
    mockFiles = [
      { name: "empty.bin", mimeType: "application/octet-stream" },
      { data: btoa("kept"), name: "kept.txt", mimeType: "text/plain" },
    ];

    const files = await pickMediaNative();

    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("kept.txt");
  });
});

describe("pickFilesNative", () => {
  test("asks for the data too", async () => {
    mockFiles = [];
    await pickFilesNative();
    expect(lastPickFilesOptions).toEqual({ readData: true });
  });
});

describe("isPickerDismissal", () => {
  test("reads the plugin's cancellation message as a dismissal", () => {
    // The message the plugin rejects with on both iOS and the web build.
    expect(isPickerDismissal(new Error("pickFiles canceled."))).toBe(true);
    // Either spelling, since the value is prose rather than a code.
    expect(isPickerDismissal(new Error("pickFiles cancelled."))).toBe(true);
  });

  test("treats anything else as a real failure", () => {
    expect(
      isPickerDismissal(new Error("Unable to copy file to temp directory")),
    ).toBe(false);
    expect(isPickerDismissal("canceled")).toBe(false);
  });
});
