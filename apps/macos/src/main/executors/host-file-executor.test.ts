import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const MOCK_DEVICE_ID = "test-device-00000000-0000-0000-0000-000000000000";
mock.module("../device-id", () => ({
  getDeviceId: () => MOCK_DEVICE_ID,
  resetDeviceIdCache: () => {},
}));

mock.module("electron-log/main", () => {
  const noop = () => {};
  return {
    default: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      initialize: noop,
      transports: { file: { maxSize: 0, fileName: "", format: "", getFile: () => ({ path: "" }) } },
    },
  };
});

const { HostProxyPoster } = await import("../host-proxy-poster");
const { hostFileExecutor, __testing } = await import("./host-file-executor");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function freshTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-file-exec-"));
  return tmpDir;
}

function capturingPoster(): {
  poster: InstanceType<typeof HostProxyPoster>;
  body: () => Record<string, unknown> | null;
} {
  let postedBody: Record<string, unknown> | null = null;
  const fakeFetch = async (_url: unknown, init?: RequestInit) => {
    postedBody = JSON.parse(init?.body as string);
    return new Response("ok");
  };
  const poster = new HostProxyPoster({
    endpointBase: "http://127.0.0.1:9000/v1",
    authHeaders: () => ({ Authorization: "Bearer t" }),
    fetch: fakeFetch as typeof globalThis.fetch,
  });
  return { poster, body: () => postedBody };
}

async function flush(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("host-file-executor", () => {
  afterEach(() => {
    __testing.pendingRequests.clear();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // -- Magic byte detection -------------------------------------------------

  describe("isImageByMagicBytes", () => {
    test("detects PNG", () => {
      const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      expect(__testing.isImageByMagicBytes(buf)).toBe(true);
    });

    test("detects JPEG", () => {
      const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      expect(__testing.isImageByMagicBytes(buf)).toBe(true);
    });

    test("detects GIF", () => {
      const buf = Buffer.from([0x47, 0x49, 0x46, 0x38]);
      expect(__testing.isImageByMagicBytes(buf)).toBe(true);
    });

    test("detects BMP", () => {
      const buf = Buffer.from([0x42, 0x4d, 0x00, 0x00]);
      expect(__testing.isImageByMagicBytes(buf)).toBe(true);
    });

    test("detects WebP", () => {
      const buf = Buffer.alloc(12);
      buf.write("RIFF", 0);
      buf.write("WEBP", 8);
      expect(__testing.isImageByMagicBytes(buf)).toBe(true);
    });

    test("returns false for text", () => {
      const buf = Buffer.from("hello world", "utf-8");
      expect(__testing.isImageByMagicBytes(buf)).toBe(false);
    });
  });

  describe("detectAudioByMagicBytes", () => {
    test("detects MP3 with ID3 tag", () => {
      const buf = Buffer.from([0x49, 0x44, 0x33, 0x00]);
      expect(__testing.detectAudioByMagicBytes(buf)).toEqual({ mimeType: "audio/mpeg" });
    });

    test("detects MP3 sync word", () => {
      const buf = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
      expect(__testing.detectAudioByMagicBytes(buf)).toEqual({ mimeType: "audio/mpeg" });
    });

    test("detects OGG", () => {
      const buf = Buffer.from([0x4f, 0x67, 0x67, 0x53]);
      expect(__testing.detectAudioByMagicBytes(buf)).toEqual({ mimeType: "audio/ogg" });
    });

    test("detects FLAC", () => {
      const buf = Buffer.from([0x66, 0x4c, 0x61, 0x43]);
      expect(__testing.detectAudioByMagicBytes(buf)).toEqual({ mimeType: "audio/flac" });
    });

    test("detects WAV", () => {
      const buf = Buffer.alloc(12);
      buf.write("RIFF", 0);
      buf.write("WAVE", 8);
      expect(__testing.detectAudioByMagicBytes(buf)).toEqual({ mimeType: "audio/wav" });
    });

    test("detects M4A", () => {
      const buf = Buffer.alloc(8);
      buf.write("ftyp", 4);
      expect(__testing.detectAudioByMagicBytes(buf)).toEqual({ mimeType: "audio/mp4" });
    });

    test("returns null for text", () => {
      const buf = Buffer.from("hello world", "utf-8");
      expect(__testing.detectAudioByMagicBytes(buf)).toBeNull();
    });
  });

  // -- Read -----------------------------------------------------------------

  describe("read", () => {
    test("rejects denied backup key basenames before reading", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, ".backup.key");
      fs.writeFileSync(filePath, "secret");

      const result = __testing.executeRead({ path: filePath });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Access to ".backup.key" is denied');
    });

    test("rejects symlinks pointing to denied basenames", () => {
      const dir = freshTmpDir();
      const target = path.join(dir, ".backup.key");
      const link = path.join(dir, "innocent.txt");
      fs.writeFileSync(target, "secret");
      fs.symlinkSync(target, link);

      const result = __testing.executeRead({ path: link });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Access to ".backup.key" is denied');
    });

    test("rejects non-regular files before reading", () => {
      const result = __testing.executeRead({ path: "/dev/null" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Not a regular file");
    });

    test("rejects oversized files before reading", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "large.txt");
      fs.closeSync(fs.openSync(filePath, "w"));
      fs.truncateSync(filePath, 100 * 1024 * 1024 + 1);

      const result = __testing.executeRead({ path: filePath });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("exceeds the 100.0 MB limit");
    });

    test("reads text file and returns content", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "hello.txt");
      fs.writeFileSync(filePath, "line1\nline2\nline3\n");

      const result = __testing.executeRead({ path: filePath });
      expect(result.content).toBe("line1\nline2\nline3\n");
      expect(result.imageData).toBeUndefined();
    });

    test("respects offset and limit", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "lines.txt");
      fs.writeFileSync(filePath, "a\nb\nc\nd\ne");

      const result = __testing.executeRead({ path: filePath, offset: 2, limit: 2 });
      expect(result.content).toBe("b\nc");
    });

    test("returns base64 imageData for PNG file", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "img.png");
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      fs.writeFileSync(filePath, pngHeader);

      const result = __testing.executeRead({ path: filePath });
      expect(result.imageData).toBe(pngHeader.toString("base64"));
      expect(result.content).toBeUndefined();
    });

    test("returns base64 audioData for WAV file", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "sound.wav");
      const wavBuf = Buffer.alloc(16);
      wavBuf.write("RIFF", 0);
      wavBuf.writeUInt32LE(8, 4);
      wavBuf.write("WAVE", 8);
      fs.writeFileSync(filePath, wavBuf);

      const result = __testing.executeRead({ path: filePath });
      expect(result.audioData).toBe(wavBuf.toString("base64"));
      expect(result.audioMimeType).toBe("audio/wav");
      expect(result.content).toBeUndefined();
    });
  });

  // -- Write ----------------------------------------------------------------

  describe("write", () => {
    test("rejects denied backup key basenames before writing", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "backup.key");

      const result = __testing.executeWrite({ path: filePath, content: "secret" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Access to "backup.key" is denied');
      expect(fs.existsSync(filePath)).toBe(false);
    });

    test("rejects oversized content before writing", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "large.txt");
      const result = __testing.validateContentSize("x".repeat(100 * 1024 * 1024 + 1), filePath);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.isError).toBe(true);
        expect(result.content).toContain("exceeds the 100.0 MB limit");
      }
    });

    test("rejects writing through symlink to denied basename", () => {
      const dir = freshTmpDir();
      const target = path.join(dir, ".backup.key");
      const link = path.join(dir, "innocent.txt");
      fs.writeFileSync(target, "original");
      fs.symlinkSync(target, link);

      const result = __testing.executeWrite({ path: link, content: "overwritten" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Access to ".backup.key" is denied');
      expect(fs.readFileSync(target, "utf-8")).toBe("original");
    });

    test("rejects writing through dangling symlink to denied basename", () => {
      const dir = freshTmpDir();
      const target = path.join(dir, "backup.key");
      const link = path.join(dir, "harmless.txt");
      // Target doesn't exist — symlink is dangling
      fs.symlinkSync(target, link);

      const result = __testing.executeWrite({ path: link, content: "secret" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Access to "backup.key" is denied');
      expect(fs.existsSync(target)).toBe(false);
    });

    test("rejects writing through multi-level symlink chain to denied basename", () => {
      const dir = freshTmpDir();
      const target = path.join(dir, ".backup.key");
      const mid = path.join(dir, "intermediate");
      const link = path.join(dir, "harmless.txt");
      fs.writeFileSync(target, "original");
      fs.symlinkSync(target, mid);
      fs.symlinkSync(mid, link);

      const result = __testing.executeWrite({ path: link, content: "overwritten" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Access to ".backup.key" is denied');
      expect(fs.readFileSync(target, "utf-8")).toBe("original");
    });

    test("rejects writing to existing non-regular file", () => {
      const result = __testing.executeWrite({ path: "/dev/null", content: "data" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Not a regular file");
    });

    test("writes content to file", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "out.txt");

      const result = __testing.executeWrite({ path: filePath, content: "hello" });
      expect(result.isError).toBeUndefined();
      expect(fs.readFileSync(filePath, "utf-8")).toBe("hello");
    });

    test("creates parent directories", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "a", "b", "c", "deep.txt");

      __testing.executeWrite({ path: filePath, content: "deep" });
      expect(fs.readFileSync(filePath, "utf-8")).toBe("deep");
    });
  });

  // -- Edit -----------------------------------------------------------------

  describe("edit", () => {
    test("rejects denied backup key basenames before editing", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, ".backup.key");
      fs.writeFileSync(filePath, "old secret");

      const result = __testing.executeEdit({
        path: filePath,
        old_string: "old",
        new_string: "new",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Access to ".backup.key" is denied');
      expect(fs.readFileSync(filePath, "utf-8")).toBe("old secret");
    });

    test("rejects oversized files before editing", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "large.txt");
      fs.closeSync(fs.openSync(filePath, "w"));
      fs.truncateSync(filePath, 100 * 1024 * 1024 + 1);

      const result = __testing.executeEdit({
        path: filePath,
        old_string: "old",
        new_string: "new",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("exceeds the 100.0 MB limit");
    });

    test("rejects edits that would produce oversized output", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "small.txt");
      fs.writeFileSync(filePath, "REPLACE_ME");

      const bigString = "x".repeat(100 * 1024 * 1024 + 1);
      const result = __testing.executeEdit({
        path: filePath,
        old_string: "REPLACE_ME",
        new_string: bigString,
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("exceeds the 100.0 MB limit");
      expect(fs.readFileSync(filePath, "utf-8")).toBe("REPLACE_ME");
    });

    test("replaces unique string", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "edit.txt");
      fs.writeFileSync(filePath, "foo bar baz");

      const result = __testing.executeEdit({
        path: filePath,
        old_string: "bar",
        new_string: "qux",
      });
      expect(result.isError).toBeUndefined();
      expect(fs.readFileSync(filePath, "utf-8")).toBe("foo qux baz");
    });

    test("errors when old_string not found", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "edit.txt");
      fs.writeFileSync(filePath, "foo bar baz");

      const result = __testing.executeEdit({
        path: filePath,
        old_string: "missing",
        new_string: "x",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found");
    });

    test("errors when old_string is not unique and replace_all is false", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "edit.txt");
      fs.writeFileSync(filePath, "foo foo bar");

      const result = __testing.executeEdit({
        path: filePath,
        old_string: "foo",
        new_string: "x",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not unique");
    });

    test("replaces all occurrences when replace_all is true", () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "edit.txt");
      fs.writeFileSync(filePath, "foo foo bar");

      const result = __testing.executeEdit({
        path: filePath,
        old_string: "foo",
        new_string: "x",
        replace_all: true,
      });
      expect(result.isError).toBeUndefined();
      expect(fs.readFileSync(filePath, "utf-8")).toBe("x x bar");
    });
  });

  // -- handleRequest integration --------------------------------------------

  describe("handleRequest", () => {
    test("posts read result to poster", async () => {
      const dir = freshTmpDir();
      const filePath = path.join(dir, "test.txt");
      fs.writeFileSync(filePath, "content here");

      const { poster, body } = capturingPoster();
      hostFileExecutor.handleRequest(
        { type: "host_file_request", requestId: "r1", operation: "read", path: filePath },
        poster,
      );
      await flush();

      expect(body()!.requestId).toBe("r1");
      expect(body()!.content).toBe("content here");
    });

    test("posts error for missing operation", async () => {
      const { poster, body } = capturingPoster();
      hostFileExecutor.handleRequest(
        { type: "host_file_request", requestId: "r2", path: "/tmp/x" },
        poster,
      );
      await flush();

      expect(body()!.isError).toBe(true);
      expect(body()!.content).toContain("Missing operation");
    });

    test("posts error for fs failure", async () => {
      const { poster, body } = capturingPoster();
      hostFileExecutor.handleRequest(
        { type: "host_file_request", requestId: "r3", operation: "read", path: "/nonexistent/path/file.txt" },
        poster,
      );
      await flush();

      expect(body()!.isError).toBe(true);
    });
  });

  // -- Cancellation ---------------------------------------------------------

  describe("cancellation", () => {
    test("handleCancel removes requestId from pending set", () => {
      __testing.pendingRequests.add("c1");
      hostFileExecutor.handleCancel(
        { type: "host_file_cancel", requestId: "c1" },
        {} as InstanceType<typeof HostProxyPoster>,
      );
      expect(__testing.pendingRequests.has("c1")).toBe(false);
    });
  });
});
