/**
 * The pickers' own read path, which the sheet's tests mock away.
 *
 * Two things matter here. The bytes arrive as base64 rather than being read
 * from a URL, because a cross-origin read of the file scheme cannot work under
 * the cloud shells' pathful `server.url`. And they are only read once the size
 * has been checked: the plugin warns that reading a large file can crash the
 * app, and both pickers default to an unlimited selection, so asking for the
 * data up front would encode a whole video before anything knew whether it
 * could be attached.
 */

import { describe, expect, mock, test } from "bun:test";

let lastPickMediaOptions: unknown = "unset";
let lastPickFilesOptions: unknown = "unset";
let mockFiles: unknown[] = [];
const readPaths: string[] = [];
let mockRead: (path: string) => string = () => "";

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

mock.module("@capacitor/filesystem", () => ({
  Filesystem: {
    readFile: ({ path }: { path: string }) => {
      readPaths.push(path);
      return Promise.resolve({ data: mockRead(path) });
    },
  },
}));

const { isPickerDismissal, pickFilesNative, pickMediaNative } =
  await import("@/domains/chat/components/chat-attachments/native-attachment-pickers");

const MB = 1024 * 1024;

function reset() {
  readPaths.length = 0;
  mockRead = () => "";
  lastPickMediaOptions = "unset";
  lastPickFilesOptions = "unset";
}

describe("native pickers: reading", () => {
  test("does not ask the plugin for the data", async () => {
    // The option the plugin warns can crash the app on a large file. Nothing
    // is read until a size has been checked, so it is never requested.
    reset();
    mockFiles = [];
    await pickMediaNative();
    await pickFilesNative();
    expect(lastPickMediaOptions).toBeUndefined();
    expect(lastPickFilesOptions).toBeUndefined();
  });

  test("rebuilds a file from the base64 it reads", async () => {
    reset();
    mockRead = () => btoa("hello bytes");
    mockFiles = [
      {
        path: "/tmp/shot.jpg",
        name: "shot.jpg",
        mimeType: "image/jpeg",
        size: 11,
      },
    ];

    const { files, skipped } = await pickMediaNative();

    expect(readPaths).toEqual(["/tmp/shot.jpg"]);
    expect(skipped).toEqual([]);
    expect(files).toHaveLength(1);
    expect(await files[0]?.text()).toBe("hello bytes");
    expect(files[0]?.type).toBe("image/jpeg");
  });

  test("keeps a zero-byte file, whose payload is an empty string", async () => {
    // Empty is a valid payload, not a missing one: the file input this
    // replaces produces a zero-byte File for the same pick.
    reset();
    mockRead = () => "";
    mockFiles = [
      {
        path: "/tmp/empty.txt",
        name: "empty.txt",
        mimeType: "text/plain",
        size: 0,
      },
    ];

    const { files } = await pickFilesNative();

    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("empty.txt");
    expect(files[0]?.size).toBe(0);
  });

  test("prefers a Blob when the web implementation supplies one", async () => {
    reset();
    mockFiles = [
      {
        blob: new Blob(["from blob"], { type: "image/png" }),
        name: "web.png",
        mimeType: "image/png",
        size: 9,
      },
    ];

    const { files } = await pickMediaNative();

    expect(readPaths).toEqual([]);
    expect(await files[0]?.text()).toBe("from blob");
  });
});

describe("native pickers: size limit", () => {
  test("refuses an oversized file before reading a byte of it", async () => {
    reset();
    mockFiles = [
      {
        path: "/tmp/huge.mov",
        name: "huge.mov",
        mimeType: "video/quicktime",
        size: 900 * MB,
      },
    ];

    const { files, skipped } = await pickMediaNative();

    // Never read: the whole point is that the bytes do not cross the bridge.
    expect(readPaths).toEqual([]);
    expect(files).toEqual([]);
    expect(skipped).toEqual(["huge.mov"]);
  });

  test("allows a resizable image past the flat cap, as the store does", async () => {
    // `composer-store` accepts a larger source for an image it will downscale,
    // so refusing it here would be stricter than the composer itself.
    reset();
    mockRead = () => btoa("jpeg bytes");
    mockFiles = [
      {
        path: "/tmp/big.jpg",
        name: "big.jpg",
        mimeType: "image/jpeg",
        size: 80 * MB,
      },
    ];

    const { files, skipped } = await pickMediaNative();

    expect(skipped).toEqual([]);
    expect(files).toHaveLength(1);
  });

  test("reads the rest of a selection when one entry is refused", async () => {
    reset();
    mockRead = () => btoa("ok");
    mockFiles = [
      {
        path: "/tmp/huge.mov",
        name: "huge.mov",
        mimeType: "video/quicktime",
        size: 900 * MB,
      },
      {
        path: "/tmp/fine.txt",
        name: "fine.txt",
        mimeType: "text/plain",
        size: 2,
      },
    ];

    const { files, skipped } = await pickFilesNative();

    expect(readPaths).toEqual(["/tmp/fine.txt"]);
    expect(files).toHaveLength(1);
    expect(skipped).toEqual(["huge.mov"]);
  });
});

describe("isPickerDismissal", () => {
  test("reads the plugin's cancellation message as a dismissal", () => {
    expect(isPickerDismissal(new Error("pickFiles canceled."))).toBe(true);
    expect(isPickerDismissal(new Error("pickFiles cancelled."))).toBe(true);
  });

  test("treats anything else as a real failure", () => {
    expect(
      isPickerDismissal(new Error("Unable to copy file to temp directory")),
    ).toBe(false);
    expect(isPickerDismissal("canceled")).toBe(false);
  });
});
