import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  AUDIO_EXTENSIONS,
  readAudioFile,
} from "../tools/shared/filesystem/audio-read.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "audio-read-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readAudioFile", () => {
  test("reads an mp3 into a base64 file block with audio/mpeg", () => {
    const p = join(dir, "clip.mp3");
    const bytes = Buffer.from("fake-audio-bytes");
    writeFileSync(p, bytes);

    const result = readAudioFile(p);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Audio loaded");
    expect(result.contentBlocks).toEqual([
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "audio/mpeg",
          data: bytes.toString("base64"),
          filename: "clip.mp3",
        },
      },
    ]);
  });

  test("maps each extension to the canonical MIME (matches migration 191)", () => {
    const cases: Record<string, string> = {
      "a.mp3": "audio/mpeg",
      "a.wav": "audio/wav",
      "a.ogg": "audio/ogg",
      "a.flac": "audio/flac",
      "a.aac": "audio/aac",
      "a.m4a": "audio/x-m4a",
      "a.opus": "audio/opus",
    };
    for (const [name, mime] of Object.entries(cases)) {
      const p = join(dir, name);
      writeFileSync(p, Buffer.from("x"));
      const result = readAudioFile(p);
      expect(result.isError).toBe(false);
      const block = result.contentBlocks?.[0] as {
        source: { media_type: string };
      };
      expect(block.source.media_type).toBe(mime);
    }
  });

  test("rejects audio larger than the 12 MB inline cap", () => {
    const p = join(dir, "big.mp3");
    writeFileSync(p, "");
    truncateSync(p, 13 * 1024 * 1024); // sparse — no 13 MB allocation

    const result = readAudioFile(p);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("too large");
    expect(result.contentBlocks).toBeUndefined();
  });

  test("errors on a missing file", () => {
    const result = readAudioFile(join(dir, "nope.mp3"));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  test("errors when the path is a directory", () => {
    const p = join(dir, "adir.mp3");
    mkdirSync(p);
    const result = readAudioFile(p);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not a file");
  });
});

describe("AUDIO_EXTENSIONS", () => {
  test("covers the supported set and excludes non-audio", () => {
    for (const ext of [
      ".mp3",
      ".wav",
      ".ogg",
      ".flac",
      ".aac",
      ".m4a",
      ".opus",
    ]) {
      expect(AUDIO_EXTENSIONS.has(ext)).toBe(true);
    }
    expect(AUDIO_EXTENSIONS.has(".txt")).toBe(false);
    expect(AUDIO_EXTENSIONS.has(".png")).toBe(false);
  });
});
