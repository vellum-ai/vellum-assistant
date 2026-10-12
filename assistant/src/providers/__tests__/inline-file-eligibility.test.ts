import { describe, expect, test } from "bun:test";

import { fileSourceMayBeInlined } from "../inline-file-eligibility.js";
import type { MediaSource } from "../types.js";

const MB = 1024 * 1024;

function ref(mediaType: string, sizeBytes: number): MediaSource {
  return {
    type: "workspace_ref",
    media_type: mediaType,
    attachmentId: "att-1",
    sizeBytes,
    filename: "attachment",
  };
}

const inlined = (mediaType: string, bytes: number): boolean =>
  fileSourceMayBeInlined(ref(mediaType, bytes), bytes);

describe("fileSourceMayBeInlined", () => {
  test("audio some adapter inlines counts; audio none inlines does not", () => {
    // WAV and MP3: OpenAI-compatible and Gemini
    expect(inlined("audio/wav", 5 * MB)).toBe(true);
    expect(inlined("audio/mpeg", 5 * MB)).toBe(true);
    // AAC, OGG, FLAC: Gemini only
    expect(inlined("audio/aac", 5 * MB)).toBe(true);
    expect(inlined("audio/ogg", 5 * MB)).toBe(true);
    expect(inlined("audio/flac", 5 * MB)).toBe(true);
    // m4a and opus: no adapter
    expect(inlined("audio/x-m4a", 5 * MB)).toBe(false);
    expect(inlined("audio/mp4", 5 * MB)).toBe(false);
    expect(inlined("audio/opus", 5 * MB)).toBe(false);
  });

  test("audio over every adapter's inline cap degrades to a note and does not count", () => {
    expect(inlined("audio/mpeg", 13 * MB)).toBe(false);
  });

  test("documents adapters inline count; files kept on disk do not", () => {
    expect(inlined("application/pdf", 2 * MB)).toBe(true);
    expect(inlined("text/plain", 1 * MB)).toBe(true);
    // over the provider string cap, text stays a workspace reference
    expect(inlined("text/plain", 9 * MB)).toBe(false);
    expect(inlined("video/mp4", 50 * MB)).toBe(false);
    expect(inlined("application/octet-stream", 1 * MB)).toBe(false);
  });
});
