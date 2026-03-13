import { describe, expect, test } from "bun:test";

import {
  estimateContentBlockTokens,
  estimateMessagesTokens,
  estimateMessageTokens,
  estimatePromptTokens,
  estimateTextTokens,
} from "../context/token-estimator.js";
import type { Message } from "../providers/types.js";

describe("token estimator", () => {
  test("estimates text tokens from character length", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("abcde")).toBe(2);
  });

  test("estimates block types with non-zero overhead", () => {
    expect(
      estimateContentBlockTokens({ type: "text", text: "hello world" }),
    ).toBeGreaterThan(0);
    expect(
      estimateContentBlockTokens({
        type: "tool_use",
        id: "t1",
        name: "bash",
        input: { command: "echo hi" },
      }),
    ).toBeGreaterThan(
      estimateContentBlockTokens({ type: "text", text: "echo hi" }),
    );
    expect(
      estimateContentBlockTokens({
        type: "tool_result",
        tool_use_id: "t1",
        content: "done",
      }),
    ).toBeGreaterThan(
      estimateContentBlockTokens({ type: "text", text: "done" }),
    );
    expect(
      estimateContentBlockTokens({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "a".repeat(100),
        },
      }),
    ).toBeGreaterThan(500);
  });

  test("estimates message and prompt totals", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Please summarize this" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Sure." },
          {
            type: "tool_use",
            id: "t1",
            name: "read_file",
            input: { path: "/tmp/a.txt" },
          },
        ],
      },
    ];
    const messagesOnly = estimateMessagesTokens(messages);
    const withSystem = estimatePromptTokens(messages, "System prompt");
    expect(estimateMessageTokens(messages[0])).toBeGreaterThan(0);
    expect(messagesOnly).toBeGreaterThan(estimateMessageTokens(messages[0]));
    expect(withSystem).toBeGreaterThan(messagesOnly);
  });

  test("counts file base64 payload for Gemini inline PDF estimation", () => {
    const sharedSource = {
      type: "base64" as const,
      filename: "report.pdf",
      media_type: "application/pdf",
    };
    const smallFileTokens = estimateContentBlockTokens(
      {
        type: "file",
        source: { ...sharedSource, data: "a".repeat(64) },
        extracted_text: "short summary",
      },
      { providerName: "gemini" },
    );
    const largeFileTokens = estimateContentBlockTokens(
      {
        type: "file",
        source: { ...sharedSource, data: "a".repeat(6400) },
        extracted_text: "short summary",
      },
      { providerName: "gemini" },
    );

    expect(largeFileTokens).toBeGreaterThan(smallFileTokens);
    expect(largeFileTokens - smallFileTokens).toBeGreaterThan(1000);
  });

  test("does not count file base64 payload for OpenAI-style file fallback", () => {
    const sharedSource = {
      type: "base64" as const,
      filename: "report.pdf",
      media_type: "application/pdf",
    };
    const smallFileTokens = estimateContentBlockTokens(
      {
        type: "file",
        source: { ...sharedSource, data: "a".repeat(64) },
        extracted_text: "short summary",
      },
      { providerName: "openai" },
    );
    const largeFileTokens = estimateContentBlockTokens(
      {
        type: "file",
        source: { ...sharedSource, data: "a".repeat(6400) },
        extracted_text: "short summary",
      },
      { providerName: "openai" },
    );

    expect(largeFileTokens).toBe(smallFileTokens);
  });

  test("estimates Anthropic PDF tokens from file size", () => {
    // ~14.8 MB PDF => ~20M base64 chars
    const base64Length = 20_000_000;
    const tokens = estimateContentBlockTokens(
      {
        type: "file",
        source: {
          type: "base64",
          filename: "large-report.pdf",
          media_type: "application/pdf",
          data: "a".repeat(base64Length),
        },
        extracted_text: "",
      },
      { providerName: "anthropic" },
    );

    // Raw bytes = 20_000_000 * 3/4 = 15_000_000
    // Estimated tokens = 15_000_000 * 0.016 = 240_000 (plus overhead)
    expect(tokens).toBeGreaterThan(200_000);
  });

  test("Anthropic PDF minimum is one page", () => {
    const tokens = estimateContentBlockTokens(
      {
        type: "file",
        source: {
          type: "base64",
          filename: "tiny.pdf",
          media_type: "application/pdf",
          data: "a".repeat(16),
        },
        extracted_text: "",
      },
      { providerName: "anthropic" },
    );

    // Should be at least ANTHROPIC_PDF_MIN_TOKENS (1600) plus overhead
    expect(tokens).toBeGreaterThanOrEqual(1600);
  });

  test("does not count non-inline file base64 payload for Gemini", () => {
    const sharedSource = {
      type: "base64" as const,
      filename: "report.txt",
      media_type: "text/plain",
    };
    const smallFileTokens = estimateContentBlockTokens(
      {
        type: "file",
        source: { ...sharedSource, data: "a".repeat(64) },
        extracted_text: "short summary",
      },
      { providerName: "gemini" },
    );
    const largeFileTokens = estimateContentBlockTokens(
      {
        type: "file",
        source: { ...sharedSource, data: "a".repeat(6400) },
        extracted_text: "short summary",
      },
      { providerName: "gemini" },
    );

    expect(largeFileTokens).toBe(smallFileTokens);
  });

  // Non-Anthropic providers use base64 payload size for image estimation
  test("scales image token estimate with base64 payload size (non-Anthropic)", () => {
    const smallImageTokens = estimateContentBlockTokens(
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "a".repeat(64),
        },
      },
      { providerName: "openai" },
    );
    const largeImageTokens = estimateContentBlockTokens(
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "a".repeat(60_000),
        },
      },
      { providerName: "openai" },
    );

    expect(largeImageTokens).toBeGreaterThan(smallImageTokens);
    expect(largeImageTokens - smallImageTokens).toBeGreaterThan(1000);
  });

  test("estimates Anthropic image tokens from dimensions, not base64 size", () => {
    // Build a minimal valid PNG header encoding 1920x1080 dimensions.
    // PNG header: 8-byte signature + 4-byte IHDR length + 4-byte "IHDR" + 4-byte width + 4-byte height = 24 bytes minimum
    const pngHeader = Buffer.alloc(24);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    pngHeader[0] = 0x89;
    pngHeader[1] = 0x50;
    pngHeader[2] = 0x4e;
    pngHeader[3] = 0x47;
    pngHeader[4] = 0x0d;
    pngHeader[5] = 0x0a;
    pngHeader[6] = 0x1a;
    pngHeader[7] = 0x0a;
    // IHDR chunk length (13 bytes)
    pngHeader.writeUInt32BE(13, 8);
    // "IHDR"
    pngHeader[12] = 0x49;
    pngHeader[13] = 0x48;
    pngHeader[14] = 0x44;
    pngHeader[15] = 0x52;
    // Width: 1920
    pngHeader.writeUInt32BE(1920, 16);
    // Height: 1080
    pngHeader.writeUInt32BE(1080, 20);

    // Pad with ~200 KB of data to simulate a real screenshot payload
    const padding = Buffer.alloc(200_000, 0x42);
    const fullPayload = Buffer.concat([pngHeader, padding]);
    const base64Data = fullPayload.toString("base64");

    const anthropicTokens = estimateContentBlockTokens(
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: base64Data },
      },
      { providerName: "anthropic" },
    );

    // 1920x1080 scaled to fit 1568x1568: scale = 1568/1920 = 0.8167
    // scaledWidth = round(1920 * 0.8167) = 1568, scaledHeight = round(1080 * 0.8167) = 882
    // tokens = ceil(1568 * 882 / 750) = ceil(1843.968) = ~1844
    // With IMAGE_BLOCK_OVERHEAD_TOKENS and media_type overhead, still well under 5000
    expect(anthropicTokens).toBeLessThan(5_000);

    // Verify it's NOT using base64 size (which would be ~50,000+ tokens)
    const nonAnthropicTokens = estimateContentBlockTokens(
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: base64Data },
      },
      { providerName: "openai" },
    );
    expect(nonAnthropicTokens).toBeGreaterThan(50_000);
  });

  test("falls back to max tokens when Anthropic image dimensions can't be parsed", () => {
    // Corrupted base64 that won't parse as a valid image header
    const corruptedData = Buffer.from(
      "not-a-valid-image-header-at-all",
    ).toString("base64");

    const tokens = estimateContentBlockTokens(
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: corruptedData,
        },
      },
      { providerName: "anthropic" },
    );

    // Should fall back to ANTHROPIC_IMAGE_MAX_TOKENS (~3,277)
    // The total will include IMAGE_BLOCK_OVERHEAD_TOKENS + media_type overhead,
    // but the max is applied at the outer Math.max(IMAGE_BLOCK_TOKENS, ...) level
    // ANTHROPIC_IMAGE_MAX_TOKENS = ceil(1568*1568/750) = 3277
    // Total = max(1024, 16 + ceil(9/4) + 3277) = max(1024, 3296) = 3296
    expect(tokens).toBeGreaterThanOrEqual(3_277);
    expect(tokens).toBeLessThan(4_000);
  });

  test("Anthropic image tokens are the same for same-dimension images regardless of payload size", () => {
    // Build two PNG headers with the same dimensions (800x600) but different payload sizes
    function makePng(
      width: number,
      height: number,
      paddingSize: number,
    ): string {
      const header = Buffer.alloc(24);
      header[0] = 0x89;
      header[1] = 0x50;
      header[2] = 0x4e;
      header[3] = 0x47;
      header[4] = 0x0d;
      header[5] = 0x0a;
      header[6] = 0x1a;
      header[7] = 0x0a;
      header.writeUInt32BE(13, 8);
      header[12] = 0x49;
      header[13] = 0x48;
      header[14] = 0x44;
      header[15] = 0x52;
      header.writeUInt32BE(width, 16);
      header.writeUInt32BE(height, 20);
      const padding = Buffer.alloc(paddingSize, 0x42);
      return Buffer.concat([header, padding]).toString("base64");
    }

    const smallPayload = makePng(800, 600, 1_000);
    const largePayload = makePng(800, 600, 200_000);

    const smallTokens = estimateContentBlockTokens(
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: smallPayload },
      },
      { providerName: "anthropic" },
    );
    const largeTokens = estimateContentBlockTokens(
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: largePayload },
      },
      { providerName: "anthropic" },
    );

    // For Anthropic, same dimensions should produce the same estimate
    expect(largeTokens).toBe(smallTokens);
  });
});
