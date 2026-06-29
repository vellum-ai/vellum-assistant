import { describe, expect, test } from "bun:test";

import {
  embeddingInputContentHash,
  type MultimodalEmbeddingInput,
  normalizeEmbeddingInput,
} from "./embedding-types.js";

describe("normalizeEmbeddingInput", () => {
  test("converts a raw string to a TextEmbeddingInput", () => {
    const result = normalizeEmbeddingInput("hello");
    expect(result).toEqual({ type: "text", text: "hello" });
  });

  test("passes through a TextEmbeddingInput unchanged", () => {
    const input: MultimodalEmbeddingInput = { type: "text", text: "hello" };
    const result = normalizeEmbeddingInput(input);
    expect(result).toEqual({ type: "text", text: "hello" });
  });

  test("passes through an ImageEmbeddingInput unchanged", () => {
    const input: MultimodalEmbeddingInput = {
      type: "image",
      data: Buffer.from("fake-png"),
      mimeType: "image/png",
    };
    const result = normalizeEmbeddingInput(input);
    expect(result).toBe(input);
  });

  test("passes through an AudioEmbeddingInput unchanged", () => {
    const input: MultimodalEmbeddingInput = {
      type: "audio",
      data: Buffer.from("fake-audio"),
      mimeType: "audio/mp3",
    };
    const result = normalizeEmbeddingInput(input);
    expect(result).toBe(input);
  });

  test("passes through a VideoEmbeddingInput unchanged", () => {
    const input: MultimodalEmbeddingInput = {
      type: "video",
      data: Buffer.from("fake-video"),
      mimeType: "video/mp4",
    };
    const result = normalizeEmbeddingInput(input);
    expect(result).toBe(input);
  });
});

describe("embeddingInputContentHash", () => {
  test("produces consistent hash for the same text input", () => {
    const hash1 = embeddingInputContentHash("hello");
    const hash2 = embeddingInputContentHash("hello");
    expect(hash1).toBe(hash2);
  });

  test("produces same hash for raw string and equivalent TextEmbeddingInput", () => {
    const hash1 = embeddingInputContentHash("hello");
    const hash2 = embeddingInputContentHash({ type: "text", text: "hello" });
    expect(hash1).toBe(hash2);
  });

  test("produces different hashes for different text inputs", () => {
    const hash1 = embeddingInputContentHash("hello");
    const hash2 = embeddingInputContentHash("world");
    expect(hash1).not.toBe(hash2);
  });

  test("produces distinct hashes for text vs binary inputs with same byte content", () => {
    const content = "hello";
    const textHash = embeddingInputContentHash(content);
    const imageHash = embeddingInputContentHash({
      type: "image",
      data: Buffer.from(content),
      mimeType: "image/png",
    });
    expect(textHash).not.toBe(imageHash);
  });

  test("produces different hashes for same data but different mime types", () => {
    const data = Buffer.from("same-data");
    const hash1 = embeddingInputContentHash({
      type: "image",
      data,
      mimeType: "image/png",
    });
    const hash2 = embeddingInputContentHash({
      type: "image",
      data,
      mimeType: "image/jpeg",
    });
    expect(hash1).not.toBe(hash2);
  });

  test("produces different hashes for same data but different modality types", () => {
    const data = Buffer.from("same-data");
    const imageHash = embeddingInputContentHash({
      type: "image",
      data,
      mimeType: "application/octet-stream",
    });
    const audioHash = embeddingInputContentHash({
      type: "audio",
      data,
      mimeType: "application/octet-stream",
    });
    expect(imageHash).not.toBe(audioHash);
  });

  test("returns a hex string", () => {
    const hash = embeddingInputContentHash("test");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
