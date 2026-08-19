/**
 * The pickers' own read path, which the sheet's tests mock away.
 *
 * Two things matter here. The bytes arrive as base64 rather than being read
 * from a URL, because a cross-origin read of the file scheme cannot work under
 * the cloud shells' pathful `server.url`. And they arrive a bounded slice at a
 * time, under limits applied to the bytes in hand: the plugin warns that
 * reading a large file can crash the app, and a document pick takes an
 * unlimited selection, so asking for the data up front would encode a whole
 * video before anything knew whether it could be attached. A reported size can
 * cut that short, but it is never what bounds a read, because a provider that
 * publishes no size is indistinguishable from one reporting an empty file.
 */

import { describe, expect, mock, test } from "bun:test";

let lastPickMediaOptions: unknown = "unset";
let lastPickFilesOptions: unknown = "unset";
let mockFiles: unknown[] = [];
const readPaths: string[] = [];
/** The plain bytes a path holds; the mock below serves ranges out of it. */
let mockContent: (path: string) => string = () => "";
/**
 * A path's length for the tests that need a genuinely large file.
 *
 * Served a slice at a time, so nothing builds the whole file, and served as a
 * Blob, which is the shape the web implementation of `readFile` answers with.
 * Both matter at this size: a fifty-megabyte case spends seconds in `atob` and
 * the per-character loop behind it, and these tests are counting bytes rather
 * than decoding them. The base64 shape every other test here uses is what
 * covers that path.
 */
let mockContentLength: (path: string) => number | null = () => null;
let mockReadError: (path: string) => Error | null = () => null;
let mockPlatform = "web";

// Spread rather than replaced: other modules in this import graph pull
// `registerPlugin` out of the same package, and a mock standing in for the
// whole of it would leave them without one.
const capacitorCore = await import("@capacitor/core");

mock.module("@capacitor/core", () => ({
  ...capacitorCore,
  Capacitor: {
    ...capacitorCore.Capacitor,
    getPlatform: () => mockPlatform,
    isNativePlatform: () => mockPlatform !== "web",
    isPluginAvailable: () => true,
  },
}));

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
    readFile: ({
      path,
      offset = 0,
      length = -1,
    }: {
      path: string;
      offset?: number;
      length?: number;
    }) => {
      readPaths.push(path);
      const failure = mockReadError(path);
      if (failure) {
        return Promise.reject(failure);
      }
      // One character stands in for one byte, which holds for the ASCII these
      // tests use and keeps the slicing arithmetic the same as the real one's.
      const synthetic = mockContentLength(path);
      if (synthetic !== null) {
        const end =
          length < 0 ? synthetic : Math.min(synthetic, offset + length);
        return Promise.resolve({
          data: new Blob([new Uint8Array(Math.max(0, end - offset))]),
        });
      }
      const whole = mockContent(path);
      const end = length < 0 ? whole.length : offset + length;
      return Promise.resolve({ data: btoa(whole.slice(offset, end)) });
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

const {
  READ_SLICE_BYTES,
  isPickerDismissal,
  pickFilesNative,
  pickMediaNative,
} =
  await import("@/domains/chat/components/chat-attachments/native-attachment-pickers");

const MB = 1024 * 1024;

/** Collects what the picker hands over, one file at a time, keeping each. */
function collector() {
  const files: File[] = [];
  return {
    files,
    onFile: (file: File) => {
      files.push(file);
      return true;
    },
  };
}

/** Takes every file and keeps none, the way a refused attachment lands. */
function discarder() {
  const files: File[] = [];
  return {
    files,
    onFile: (file: File) => {
      files.push(file);
      return false;
    },
  };
}

function reset() {
  readPaths.length = 0;
  statPaths.length = 0;
  deletedPaths.length = 0;
  mockStat = () => 0;
  mockContent = () => "";
  mockContentLength = () => null;
  mockReadError = () => null;
  mockPlatform = "web";
  lastPickMediaOptions = "unset";
  lastPickFilesOptions = "unset";
}

describe("native pickers: reading", () => {
  test("does not ask the plugin for the data", async () => {
    // The option the plugin warns can crash the app on a large file. Nothing
    // is read until a size has been checked, so it is never requested.
    reset();
    mockFiles = [];
    await pickMediaNative(() => true);
    await pickFilesNative(() => true);
    expect(lastPickMediaOptions).toBeUndefined();
    expect(lastPickFilesOptions).toBeUndefined();
  });

  test("rebuilds a file from the base64 it reads", async () => {
    reset();
    mockContent = () => "hello bytes";
    mockFiles = [
      {
        path: "/tmp/shot.jpg",
        name: "shot.jpg",
        mimeType: "image/jpeg",
        size: 11,
      },
    ];

    const sink = collector();
    const { tooLarge, pickFull } = await pickMediaNative(sink.onFile);
    const files = sink.files;

    expect(readPaths).toEqual(["/tmp/shot.jpg"]);
    expect(tooLarge).toEqual([]);
    expect(pickFull).toEqual([]);
    expect(files).toHaveLength(1);
    expect(await files[0]?.text()).toBe("hello bytes");
    expect(files[0]?.type).toBe("image/jpeg");
  });

  test("keeps a zero-byte file, which reads back as no bytes", async () => {
    // Empty is a valid payload, not a missing one, and a file input produces a
    // zero-byte File for the same pick. It takes a read to establish that,
    // since a reported zero is also what a provider with no size looks like.
    reset();
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

    expect(readPaths).toEqual(["/tmp/empty.txt"]);
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

describe("native pickers: slicing the read", () => {
  test("reassembles a file that spans more than one slice", async () => {
    // A whole-file read costs several times the file in transient memory at
    // once, which is what a phone web view dies of. The join is the risk this
    // covers: parts arriving out of order or a boundary landing mid-byte would
    // corrupt an upload silently.
    reset();
    const tail = "boundary";
    mockContent = () => "a".repeat(READ_SLICE_BYTES) + tail;
    mockFiles = [
      {
        path: "/tmp/long.bin",
        name: "long.bin",
        mimeType: "application/octet-stream",
        size: READ_SLICE_BYTES + tail.length,
      },
    ];

    const sink = collector();
    const { tooLarge, pickFull } = await pickFilesNative(sink.onFile);
    const file = sink.files[0];

    expect(tooLarge).toEqual([]);
    expect(pickFull).toEqual([]);
    expect(readPaths).toEqual(["/tmp/long.bin", "/tmp/long.bin"]);
    expect(file?.size).toBe(READ_SLICE_BYTES + tail.length);
    expect((await (file as File).text()).endsWith(tail)).toBe(true);
  });

  test("reads past a size that understates the file", async () => {
    // A reported size can refuse an entry but never bounds its read: a
    // provider that understates one would otherwise truncate the upload
    // silently, which is worse than refusing it.
    reset();
    mockContent = () => "hello bytes";
    mockFiles = [
      {
        path: "/tmp/understated.txt",
        name: "understated.txt",
        mimeType: "text/plain",
        size: 3,
      },
    ];

    const sink = collector();
    await pickFilesNative(sink.onFile);

    expect(await sink.files[0]?.text()).toBe("hello bytes");
  });

  test("stops at the first short answer rather than reading on", async () => {
    // A provider that overstates a size would otherwise keep asking past the
    // end of the file for every slice the number claims is left.
    reset();
    mockContent = () => "short";
    mockFiles = [
      {
        path: "/tmp/overstated.bin",
        name: "overstated.bin",
        mimeType: "application/octet-stream",
        size: 30 * MB,
      },
    ];

    const sink = collector();
    await pickFilesNative(sink.onFile);

    expect(readPaths).toEqual(["/tmp/overstated.bin"]);
    expect(sink.files[0]?.size).toBe(5);
  });
});

describe("native pickers: selection limit", () => {
  test("bounds what an iOS media pick may copy before it resolves", async () => {
    // iOS copies every selected representation into Caches before resolving,
    // so nothing here can refuse a byte until the whole selection is on disk.
    reset();
    mockPlatform = "ios";
    mockFiles = [];

    await pickMediaNative(() => true);

    expect(lastPickMediaOptions).toEqual({ limit: 10 });
  });

  test("leaves an Android media pick unbounded", async () => {
    // Android reads any non-zero limit as single-select, and hands back
    // provider URIs rather than copies, so there is nothing to bound.
    reset();
    mockPlatform = "android";
    mockFiles = [];

    await pickMediaNative(() => true);

    expect(lastPickMediaOptions).toBeUndefined();
  });

  test("leaves a document pick unbounded on iOS too", async () => {
    // `allowsMultipleSelection` is `limit == 0` there, so any bound at all
    // would cost multi-select outright.
    reset();
    mockPlatform = "ios";
    mockFiles = [];

    await pickFilesNative(() => true);

    expect(lastPickFilesOptions).toBeUndefined();
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
    const { tooLarge, pickFull } = await pickMediaNative(sink.onFile);
    const files = sink.files;

    // Never read: the whole point is that the bytes do not cross the bridge.
    expect(readPaths).toEqual([]);
    expect(files).toEqual([]);
    expect(tooLarge).toEqual(["huge.mov"]);
    expect(pickFull).toEqual([]);
  });

  test("allows a resizable image past the flat cap, as the store does", async () => {
    // `composer-store` accepts a larger source for an image it will downscale,
    // so refusing it here would be stricter than the composer itself.
    reset();
    mockContent = () => "jpeg bytes";
    mockFiles = [
      {
        path: "/tmp/big.jpg",
        name: "big.jpg",
        mimeType: "image/jpeg",
        size: 80 * MB,
      },
    ];

    const sink = collector();
    const { tooLarge, pickFull } = await pickMediaNative(sink.onFile);
    const files = sink.files;

    expect(tooLarge).toEqual([]);
    expect(pickFull).toEqual([]);
    expect(files).toHaveLength(1);
  });

  test("reads the rest of a selection when one entry is refused", async () => {
    reset();
    mockContent = () => "ok";
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
    const { tooLarge, pickFull } = await pickFilesNative(sink.onFile);
    const files = sink.files;

    expect(readPaths).toEqual(["/tmp/fine.txt"]);
    expect(files).toHaveLength(1);
    expect(tooLarge).toEqual(["huge.mov"]);
    expect(pickFull).toEqual([]);
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
    mockFiles = [
      { path: "/a.txt", name: "a.txt", mimeType: "text/plain", size: 1 },
      { path: "/b.txt", name: "b.txt", mimeType: "text/plain", size: 1 },
    ];

    const events: string[] = [];
    mockContent = (path: string) => {
      events.push(`read ${path}`);
      return "x";
    };

    await pickFilesNative((file) => {
      events.push(`deliver ${file.name}`);
      return true;
    });

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
    const { tooLarge, pickFull } = await pickFilesNative(sink.onFile);

    expect(statPaths).toEqual(["/cloud.doc"]);
    expect(readPaths).toEqual([]);
    expect(sink.files).toEqual([]);
    expect(tooLarge).toEqual(["cloud.doc"]);
    expect(pickFull).toEqual([]);
  });

  test("still attaches a file that is genuinely empty", async () => {
    reset();
    mockStat = () => 0;
    mockFiles = [
      {
        path: "/empty.txt",
        name: "empty.txt",
        mimeType: "text/plain",
        size: 0,
      },
    ];

    const sink = collector();
    const { tooLarge, pickFull } = await pickFilesNative(sink.onFile);

    expect(tooLarge).toEqual([]);
    expect(pickFull).toEqual([]);
    expect(sink.files).toHaveLength(1);
    expect(sink.files[0]?.size).toBe(0);
  });

  test("reads a stat of zero rather than calling the file empty", async () => {
    // The stat asks the same provider the picker did, so it answers zero both
    // for an empty file and for one whose length it does not publish. Taking
    // that as a length would attach a cloud-backed document as nothing at all.
    reset();
    mockStat = () => 0;
    mockContent = () => "real contents";
    mockFiles = [
      {
        path: "/cloud.txt",
        name: "cloud.txt",
        mimeType: "text/plain",
        size: 0,
      },
    ];

    const sink = collector();
    const { tooLarge, pickFull } = await pickFilesNative(sink.onFile);

    expect(tooLarge).toEqual([]);
    expect(pickFull).toEqual([]);
    expect(sink.files).toHaveLength(1);
    expect(await sink.files[0]?.text()).toBe("real contents");
  });

  test("reads under the limits when the size stays unknown", async () => {
    // A stat that fails leaves nothing to judge the entry on in advance, so
    // the read is what judges it, on the bytes that turn up.
    reset();
    mockStat = () => new Error("stat failed");
    mockContent = () => "bytes";
    mockFiles = [
      {
        path: "/unknown.bin",
        name: "unknown.bin",
        mimeType: "application/octet-stream",
        size: 0,
      },
    ];

    const sink = collector();
    const { tooLarge, pickFull } = await pickFilesNative(sink.onFile);

    expect(tooLarge).toEqual([]);
    expect(pickFull).toEqual([]);
    expect(readPaths).toEqual(["/unknown.bin"]);
    expect(sink.files[0]?.size).toBe(5);
  });

  test("abandons an unknown-size file that outgrows the limit mid-read", async () => {
    // Nothing can refuse this entry in advance, so the read is what has to
    // notice. It gives up on the slice that crosses the limit rather than
    // assembling a file it was always going to turn away.
    reset();
    mockStat = () => new Error("stat failed");
    mockContentLength = () => 60 * MB;
    mockFiles = [
      {
        path: "/unknown.bin",
        name: "unknown.bin",
        mimeType: "application/octet-stream",
        size: 0,
      },
    ];

    const sink = collector();
    const { tooLarge, pickFull } = await pickFilesNative(sink.onFile);

    expect(sink.files).toEqual([]);
    expect(tooLarge).toEqual(["unknown.bin"]);
    expect(pickFull).toEqual([]);
    expect(readPaths.length).toBeLessThan((60 * MB) / READ_SLICE_BYTES);
  });
});

describe("native pickers: spending the allowance", () => {
  test("stops reading once one pick has taken its whole allowance", async () => {
    // Every file here passes on its own. Per-file checks alone therefore do
    // not bound a multi-select, because the composer holds each one it has
    // been handed while its upload runs. The bytes are real rather than
    // claimed, since what a pick has spent is what it has actually read.
    reset();
    mockContentLength = () => 51 * MB;
    mockFiles = [
      {
        path: "/1.jpg",
        name: "1.jpg",
        mimeType: "image/jpeg",
        size: 51 * MB,
      },
      {
        path: "/2.jpg",
        name: "2.jpg",
        mimeType: "image/jpeg",
        size: 51 * MB,
      },
    ];

    const sink = collector();
    const { tooLarge, pickFull } = await pickFilesNative(sink.onFile);

    // 100 MB of allowance, so the second never gets read.
    expect(readPaths).not.toContain("/2.jpg");
    expect(sink.files).toHaveLength(1);
    expect(sink.files[0]?.size).toBe(51 * MB);
    expect(pickFull).toEqual(["2.jpg"]);
    expect(tooLarge).toEqual([]);
  });
});

describe("native pickers: aggregate budget", () => {
  test("charges what an understated entry actually read", async () => {
    // A size below the truth is the dangerous direction: nothing else counts
    // the difference, so charging the claim would let a pick hold well past
    // the allowance. The second entry is refused only if the first was
    // charged for its bytes rather than for the single byte it reported.
    reset();
    mockContent = (path: string) =>
      path === "/understated.bin" ? "a".repeat(READ_SLICE_BYTES) : "x";
    mockFiles = [
      {
        path: "/understated.bin",
        name: "understated.bin",
        mimeType: "application/octet-stream",
        size: 1,
      },
      {
        path: "/next.jpg",
        name: "next.jpg",
        mimeType: "image/jpeg",
        size: 97 * MB,
      },
    ];

    const sink = collector();
    const { tooLarge, pickFull } = await pickFilesNative(sink.onFile);

    expect(sink.files).toHaveLength(1);
    expect(sink.files[0]?.size).toBe(READ_SLICE_BYTES);
    expect(pickFull).toEqual(["next.jpg"]);
    expect(tooLarge).toEqual([]);
  });

  test("charges what an overstated entry actually read", async () => {
    // A size above the truth spends allowance on bytes the pick never held.
    // The second entry fits alongside a one-byte file and is attached only if
    // the first was charged for what it delivered rather than what it claimed.
    reset();
    mockContent = () => "x";
    mockFiles = [
      {
        path: "/overstated.bin",
        name: "overstated.bin",
        mimeType: "application/octet-stream",
        size: 45 * MB,
      },
      {
        path: "/next.jpg",
        name: "next.jpg",
        mimeType: "image/jpeg",
        size: 97 * MB,
      },
    ];

    const sink = collector();
    const { tooLarge, pickFull } = await pickFilesNative(sink.onFile);

    expect(sink.files).toHaveLength(2);
    expect(pickFull).toEqual([]);
    expect(tooLarge).toEqual([]);
  });
});

describe("native pickers: what holds the assembled bytes", () => {
  test("hands each slice to blob storage rather than keeping arrays", async () => {
    // Collecting arrays and letting the `File` snapshot them at the end put
    // the whole file in script memory twice over, which on a large image is
    // what a phone web view dies of. The bytes have to survive the transfer
    // intact either way, so the join is asserted rather than the mechanism.
    reset();
    const tail = "boundary";
    mockContent = () => "a".repeat(READ_SLICE_BYTES) + tail;
    mockFiles = [
      {
        path: "/tmp/two-slices.bin",
        name: "two-slices.bin",
        mimeType: "application/octet-stream",
        size: READ_SLICE_BYTES + tail.length,
      },
    ];

    const sink = collector();
    await pickFilesNative(sink.onFile);
    const file = sink.files[0] as File;

    expect(readPaths).toHaveLength(2);
    expect(file.size).toBe(READ_SLICE_BYTES + tail.length);
    expect((await file.text()).endsWith(tail)).toBe(true);
  });
});

describe("native pickers: files the composer turns away", () => {
  test("leaves the allowance untouched for a file that is not kept", async () => {
    // The composer drops images outright when the model cannot see them, and
    // a dropped file is never held, so charging the pick for it would refuse
    // the next valid file with a batch message that is not true of it.
    reset();
    mockContent = () => "x";
    mockContentLength = (path) =>
      path === "/big.jpg" ? READ_SLICE_BYTES : null;
    mockFiles = [
      {
        path: "/big.jpg",
        name: "big.jpg",
        mimeType: "image/jpeg",
        size: 80 * MB,
      },
      {
        path: "/next.jpg",
        name: "next.jpg",
        mimeType: "image/jpeg",
        size: 97 * MB,
      },
    ];

    const sink = discarder();
    const { tooLarge, pickFull } = await pickFilesNative(sink.onFile);

    // Both were read and offered. The second claims all but a slice of the
    // allowance, so it survives only because the dropped image spent none.
    expect(sink.files.map((file) => file.name)).toEqual([
      "big.jpg",
      "next.jpg",
    ]);
    expect(pickFull).toEqual([]);
    expect(tooLarge).toEqual([]);
  });

  test("still charges the files it does keep", async () => {
    // The same selection as above, kept rather than dropped, which is the one
    // difference that leaves the second entry nothing to spend.
    reset();
    mockContent = () => "x";
    mockContentLength = (path) =>
      path === "/big.jpg" ? READ_SLICE_BYTES : null;
    mockFiles = [
      {
        path: "/big.jpg",
        name: "big.jpg",
        mimeType: "image/jpeg",
        size: 80 * MB,
      },
      {
        path: "/next.jpg",
        name: "next.jpg",
        mimeType: "image/jpeg",
        size: 97 * MB,
      },
    ];

    const sink = collector();
    const { tooLarge, pickFull } = await pickFilesNative(sink.onFile);

    expect(sink.files.map((file) => file.name)).toEqual(["big.jpg"]);
    expect(pickFull).toEqual(["next.jpg"]);
    expect(tooLarge).toEqual([]);
  });
});

describe("native pickers: missing metadata", () => {
  test("survives a provider that reports no mime type", async () => {
    // Android leaves this null when the provider does not publish one, and the
    // resize check reads it as a string.
    reset();
    mockContent = () => "bytes";
    mockFiles = [
      { path: "/nomime.jpg", name: "nomime.jpg", mimeType: null, size: 10 },
    ];

    const sink = collector();
    const { tooLarge, pickFull } = await pickFilesNative(sink.onFile);

    expect(tooLarge).toEqual([]);
    expect(pickFull).toEqual([]);
    expect(sink.files).toHaveLength(1);
    expect(sink.files[0]?.name).toBe("nomime.jpg");
  });

  test("still lets a large image through on its extension alone", async () => {
    // Past the flat cap and with no mime type to go on, so only the filename
    // can identify it as resizable, which is what a file input goes on too.
    reset();
    mockContent = () => "bytes";
    mockFiles = [
      { path: "/big.jpg", name: "big.jpg", mimeType: null, size: 80 * MB },
    ];

    const sink = collector();
    const { tooLarge, pickFull } = await pickFilesNative(sink.onFile);

    expect(tooLarge).toEqual([]);
    expect(pickFull).toEqual([]);
    expect(sink.files).toHaveLength(1);
  });
});

describe("native pickers: temporary copies", () => {
  test("drops the copy after reading it", async () => {
    // iOS copies every selection into a fresh directory under Caches and never
    // clears it up, so a path handed back there is ours to remove once the
    // bytes are in memory.
    reset();
    mockContent = () => "bytes";
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
    const { tooLarge, pickFull } = await pickFilesNative(sink.onFile);

    expect(readPaths).toEqual([]);
    expect(tooLarge).toEqual(["huge.mov"]);
    expect(pickFull).toEqual([]);
    expect(deletedPaths).toEqual(["/Caches/def/huge.mov"]);
  });

  test("drops the copies it never reached when a read fails", async () => {
    // The picker had already copied the whole selection before any of this
    // ran, so an entry the loop never visits still has a copy to its name.
    reset();
    mockContent = () => "bytes";
    mockReadError = (path: string) =>
      path === "/Caches/ghi/first.jpg" ? new Error("read failed") : null;
    mockFiles = [
      {
        path: "/Caches/ghi/first.jpg",
        name: "first.jpg",
        mimeType: "image/jpeg",
        size: 10,
      },
      {
        path: "/Caches/ghi/second.jpg",
        name: "second.jpg",
        mimeType: "image/jpeg",
        size: 10,
      },
    ];

    const sink = collector();
    await expect(pickMediaNative(sink.onFile)).rejects.toThrow("read failed");

    expect(sink.files).toEqual([]);
    expect(deletedPaths).toEqual([
      "/Caches/ghi/first.jpg",
      "/Caches/ghi/second.jpg",
    ]);
  });

  test("leaves an Android content URI alone", async () => {
    // That names the provider's own document rather than a copy, so deleting
    // it would delete the user's file.
    reset();
    mockContent = () => "bytes";
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
