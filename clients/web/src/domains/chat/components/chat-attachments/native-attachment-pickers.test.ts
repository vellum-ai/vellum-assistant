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

const statPaths: string[] = [];
const deletedPaths: string[] = [];
let mockStat: (path: string) => number | Error = () => 0;

mock.module("@capacitor/filesystem", () => ({
  Filesystem: {
    readFile: ({ path }: { path: string }) => {
      readPaths.push(path);
      return Promise.resolve({ data: mockRead(path) });
    },
    deleteFile: ({ path }: { path: string }) => {
      deletedPaths.push(path);
      return Promise.resolve();
    },
    stat: ({ path }: { path: string }) => {
      statPaths.push(path);
      const size = mockStat(path);
      return size instanceof Error
        ? Promise.reject(size)
        : Promise.resolve({ size });
    },
  },
}));

const { isPickerDismissal, pickFilesNative, pickMediaNative } =
  await import("@/domains/chat/components/chat-attachments/native-attachment-pickers");

const MB = 1024 * 1024;

/** Collects what the picker hands over, one file at a time. */
function collector() {
  const files: File[] = [];
  return { files, onFile: (file: File) => files.push(file) };
}

function reset() {
  readPaths.length = 0;
  statPaths.length = 0;
  deletedPaths.length = 0;
  mockStat = () => 0;
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
    await pickMediaNative(() => {});
    await pickFilesNative(() => {});
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

    const sink = collector();
    const { skipped } = await pickMediaNative(sink.onFile);
    const files = sink.files;

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

    const sink = collector();
    await pickFilesNative(sink.onFile);
    const files = sink.files;

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

    const sink = collector();
    await pickMediaNative(sink.onFile);
    const files = sink.files;

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

    const sink = collector();
    const { skipped } = await pickMediaNative(sink.onFile);
    const files = sink.files;

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

    const sink = collector();
    const { skipped } = await pickMediaNative(sink.onFile);
    const files = sink.files;

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

    const sink = collector();
    const { skipped } = await pickFilesNative(sink.onFile);
    const files = sink.files;

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

describe("native pickers: bounding what is held at once", () => {
  test("hands each file over before reading the next", async () => {
    // Collecting into an array and returning it at the end would hold every
    // decoded file at once, so several large-but-valid documents exhaust the
    // web view exactly as one huge file would. The order here is the point:
    // each read is followed by its delivery, not by the next read.
    reset();
    mockRead = () => btoa("x");
    mockFiles = [
      { path: "/a.txt", name: "a.txt", mimeType: "text/plain", size: 1 },
      { path: "/b.txt", name: "b.txt", mimeType: "text/plain", size: 1 },
    ];

    const events: string[] = [];
    mockRead = (path: string) => {
      events.push(`read ${path}`);
      return btoa("x");
    };

    await pickFilesNative((file) => events.push(`deliver ${file.name}`));

    expect(events).toEqual([
      "read /a.txt",
      "deliver a.txt",
      "read /b.txt",
      "deliver b.txt",
    ]);
  });
});

describe("native pickers: unknown sizes", () => {
  test("stats a zero-size entry rather than trusting it", async () => {
    // Android reports 0 both for an empty file and for a provider that does
    // not publish a size, so a large cloud-backed document arrives looking
    // safely tiny.
    reset();
    mockStat = () => 900 * MB;
    mockFiles = [
      {
        path: "/cloud.doc",
        name: "cloud.doc",
        mimeType: "application/msword",
        size: 0,
      },
    ];

    const sink = collector();
    const { skipped } = await pickFilesNative(sink.onFile);

    expect(statPaths).toEqual(["/cloud.doc"]);
    expect(readPaths).toEqual([]);
    expect(sink.files).toEqual([]);
    expect(skipped).toEqual(["cloud.doc"]);
  });

  test("still attaches a file that is genuinely empty", async () => {
    reset();
    mockStat = () => 0;
    mockRead = () => "";
    mockFiles = [
      {
        path: "/empty.txt",
        name: "empty.txt",
        mimeType: "text/plain",
        size: 0,
      },
    ];

    const sink = collector();
    const { skipped } = await pickFilesNative(sink.onFile);

    expect(skipped).toEqual([]);
    expect(sink.files).toHaveLength(1);
    expect(sink.files[0]?.size).toBe(0);
  });

  test("refuses rather than reads when the size stays unknown", async () => {
    // Losing an empty attachment costs an attachment; reading a file of
    // unknown size costs the web view.
    reset();
    mockStat = () => new Error("stat failed");
    mockFiles = [
      {
        path: "/unknown.bin",
        name: "unknown.bin",
        mimeType: "application/octet-stream",
        size: 0,
      },
    ];

    const sink = collector();
    const { skipped } = await pickFilesNative(sink.onFile);

    expect(readPaths).toEqual([]);
    expect(skipped).toEqual(["unknown.bin"]);
  });
});

describe("native pickers: aggregate budget", () => {
  test("stops reading once one pick has taken its whole allowance", async () => {
    // Every file here passes on its own. Per-file checks alone therefore do
    // not bound a multi-select, because the composer holds each one it has
    // been handed while its upload runs.
    reset();
    mockRead = () => btoa("x");
    mockFiles = [
      {
        path: "/1.bin",
        name: "1.bin",
        mimeType: "application/octet-stream",
        size: 45 * MB,
      },
      {
        path: "/2.bin",
        name: "2.bin",
        mimeType: "application/octet-stream",
        size: 45 * MB,
      },
      {
        path: "/3.bin",
        name: "3.bin",
        mimeType: "application/octet-stream",
        size: 45 * MB,
      },
    ];

    const sink = collector();
    const { skipped } = await pickFilesNative(sink.onFile);

    // 100 MB of allowance, so the third never gets read.
    expect(readPaths).toEqual(["/1.bin", "/2.bin"]);
    expect(sink.files).toHaveLength(2);
    expect(skipped).toEqual(["3.bin"]);
  });
});

describe("native pickers: missing metadata", () => {
  test("survives a provider that reports no mime type", async () => {
    // Android leaves this null when the provider does not publish one, and the
    // resize check reads it as a string.
    reset();
    mockRead = () => btoa("bytes");
    mockFiles = [
      { path: "/nomime.jpg", name: "nomime.jpg", mimeType: null, size: 10 },
    ];

    const sink = collector();
    const { skipped } = await pickFilesNative(sink.onFile);

    expect(skipped).toEqual([]);
    expect(sink.files).toHaveLength(1);
    expect(sink.files[0]?.name).toBe("nomime.jpg");
  });

  test("still lets a large image through on its extension alone", async () => {
    // Past the flat cap and with no mime type to go on, so only the filename
    // can identify it as resizable. The input path this replaces accepts it.
    reset();
    mockRead = () => btoa("bytes");
    mockFiles = [
      { path: "/big.jpg", name: "big.jpg", mimeType: null, size: 80 * MB },
    ];

    const sink = collector();
    const { skipped } = await pickFilesNative(sink.onFile);

    expect(skipped).toEqual([]);
    expect(sink.files).toHaveLength(1);
  });
});

describe("native pickers: temporary copies", () => {
  test("drops the copy after reading it", async () => {
    // iOS copies every selection into a fresh directory under Caches and never
    // clears it up, so a path handed back there is ours to remove once the
    // bytes are in memory.
    reset();
    mockRead = () => btoa("bytes");
    mockFiles = [
      {
        path: "/Caches/abc/photo.jpg",
        name: "photo.jpg",
        mimeType: "image/jpeg",
        size: 10,
      },
    ];

    const sink = collector();
    await pickMediaNative(sink.onFile);

    expect(sink.files).toHaveLength(1);
    expect(deletedPaths).toEqual(["/Caches/abc/photo.jpg"]);
  });

  test("drops the copy of a file it refuses to read", async () => {
    // The worst case for leaving them behind: bytes nobody wanted, kept.
    reset();
    mockFiles = [
      {
        path: "/Caches/def/huge.mov",
        name: "huge.mov",
        mimeType: "video/quicktime",
        size: 900 * MB,
      },
    ];

    const sink = collector();
    const { skipped } = await pickFilesNative(sink.onFile);

    expect(readPaths).toEqual([]);
    expect(skipped).toEqual(["huge.mov"]);
    expect(deletedPaths).toEqual(["/Caches/def/huge.mov"]);
  });

  test("leaves an Android content URI alone", async () => {
    // That names the provider's own document rather than a copy, so deleting
    // it would delete the user's file.
    reset();
    mockRead = () => btoa("bytes");
    mockFiles = [
      {
        path: "content://downloads/42",
        name: "doc.pdf",
        mimeType: "application/pdf",
        size: 10,
      },
    ];

    const sink = collector();
    await pickFilesNative(sink.onFile);

    expect(sink.files).toHaveLength(1);
    expect(deletedPaths).toEqual([]);
  });
});
