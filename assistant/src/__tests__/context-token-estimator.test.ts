import { describe, expect, test } from "bun:test";

import {
  estimateContentBlockTokens,
  estimateMessagesTokens,
  estimateMessageTokens,
  estimatePromptTokens,
  estimateTextTokens,
} from "../context/token-estimator.js";
import type { Message } from "../providers/types.js";

/** Build a minimal valid PNG header with the given dimensions, returned as base64. */
function makePngBase64(width: number, height: number): string {
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
  return header.toString("base64");
}

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
    ).toBeGreaterThan(0);
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

    // 1920x1080 scaled to fit 1568px bounding box: dimScale = 1568/1920 = 0.8167
    // scaledWidth = round(1920 * 0.8167) = 1568, scaledHeight = round(1080 * 0.8167) = 882
    // pixels = 1568 * 882 = 1,382,976 > 1,200,000 → mpScale = sqrt(1200000/1382976) = 0.9315
    // scaledWidth = round(1568 * 0.9315) = 1461, scaledHeight = round(882 * 0.9315) = 822
    // tokens = ceil(1461 * 822 / 750) = ceil(1601.26) = ~1,602
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

    // Should fall back to ANTHROPIC_IMAGE_MAX_TOKENS (1,600)
    // Total = 16 (block overhead) + ceil(9/4) (media_type) + 1600 = 1619
    expect(tokens).toBeGreaterThanOrEqual(1_600);
    expect(tokens).toBeLessThan(2_000);
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

  test("applies megapixel cap for square images on Anthropic", () => {
    // Build a minimal valid PNG header encoding 2000x2000 dimensions.
    const pngHeader = Buffer.alloc(24);
    // PNG signature
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
    // Width: 2000
    pngHeader.writeUInt32BE(2000, 16);
    // Height: 2000
    pngHeader.writeUInt32BE(2000, 20);

    const base64Data = pngHeader.toString("base64");

    const tokens = estimateContentBlockTokens(
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: base64Data },
      },
      { providerName: "anthropic" },
    );

    // 2000x2000 → dimScale = 1568/2000 = 0.784 → 1568x1568 = 2,458,624 pixels
    // 2,458,624 > 1,200,000 → mpScale = sqrt(1200000/2458624) ≈ 0.6987
    // scaledWidth = round(1568 * 0.6987) = 1096, scaledHeight = round(1568 * 0.6987) = 1096
    // tokens = ceil(1096 * 1096 / 750) = ceil(1601.6) ≈ 1602
    // Without megapixel cap would have been ceil(1568 * 1568 / 750) ≈ 3277
    expect(tokens).toBeLessThanOrEqual(1_700);
  });

  test("small Anthropic images are not inflated to 1024 tokens", () => {
    // 200x200 image: ceil(200*200/750) = ceil(53.33) = 54 tokens
    const tokens = estimateContentBlockTokens(
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: makePngBase64(200, 200),
        },
      },
      { providerName: "anthropic" },
    );

    // 54 (dimension-based) + 16 (block overhead) + 3 (media type) = 73
    expect(tokens).toBeLessThan(100);
    expect(tokens).toBeGreaterThan(50);
  });

  test("thumbnail Anthropic images estimate accurately", () => {
    // 150x150 image: ceil(150*150/750) = ceil(30) = 30 tokens
    const tokens = estimateContentBlockTokens(
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: makePngBase64(150, 150),
        },
      },
      { providerName: "anthropic" },
    );

    // 30 + 16 + 3 = 49
    expect(tokens).toBeLessThan(70);
    expect(tokens).toBeGreaterThan(30);
  });

  test("many small Anthropic images do not trigger phantom token inflation", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: Array.from({ length: 100 }, () => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: "image/png",
            data: makePngBase64(200, 200),
          },
        })),
      },
    ];

    const total = estimateMessagesTokens(messages, { providerName: "anthropic" });

    // Each image: ~73 tokens. 100 images + message overhead ≈ 7,304
    // Old behavior: 100 * ~1,043 = ~104,300 (14x overestimate)
    expect(total).toBeLessThan(10_000);
  });

  test("matches Anthropic's published table for common aspect ratios", () => {
    // These are the max sizes that should NOT be further scaled (at or below the megapixel cap).
    // 1:1 → 1092x1092 (~1,590 tokens)
    const squareTokens = estimateContentBlockTokens(
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: makePngBase64(1092, 1092),
        },
      },
      { providerName: "anthropic" },
    );

    // 1:2 → 784x1568 (~1,639 tokens)
    const tallTokens = estimateContentBlockTokens(
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: makePngBase64(784, 1568),
        },
      },
      { providerName: "anthropic" },
    );

    // 1092x1092 = 1,192,464 pixels < 1,200,000 → no megapixel scaling needed.
    // tokens = ceil(1092 * 1092 / 750) = ceil(1589.95) ≈ 1590
    // With overhead: 16 + 3 + 1590 = 1609
    expect(squareTokens).toBeGreaterThan(1_400);
    expect(squareTokens).toBeLessThan(1_800);

    // 784*1568 = 1,229,312 > 1,200,000 → slight scaling applies
    // mpScale = sqrt(1200000/1229312) ≈ 0.9881
    // scaledWidth = round(784 * 0.9881) = 775, scaledHeight = round(1568 * 0.9881) = 1549
    // tokens = ceil(775 * 1549 / 750) = ceil(1600.6) ≈ 1601
    // With overhead: 16 + 3 + 1601 = 1620
    expect(tallTokens).toBeGreaterThan(1_400);
    expect(tallTokens).toBeLessThan(1_800);
  });
});

describe("tool_result estimation mirrors Anthropic wire format", () => {
  test("plain text tool_result counts overhead + id + content", () => {
    const tokens = estimateContentBlockTokens({
      type: "tool_result",
      tool_use_id: "call_1",
      content: "operation complete",
    });
    // Sanity bounds — small string, small overhead.
    expect(tokens).toBeGreaterThan(estimateTextTokens("operation complete"));
    expect(tokens).toBeLessThan(estimateTextTokens("operation complete") + 50);
  });

  test("image sub-block is counted when is_error is false", () => {
    const pngBase64 = makePngBase64(512, 512);
    const withImage = estimateContentBlockTokens(
      {
        type: "tool_result",
        tool_use_id: "call_img",
        content: "screenshot captured",
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: pngBase64,
            },
          },
        ],
      },
      { providerName: "anthropic" },
    );
    const withoutImage = estimateContentBlockTokens(
      {
        type: "tool_result",
        tool_use_id: "call_img",
        content: "screenshot captured",
      },
      { providerName: "anthropic" },
    );
    // 512x512 = 262144 pixels, tokens ≈ ceil(262144/750) ≈ 350.
    expect(withImage - withoutImage).toBeGreaterThan(300);
    expect(withImage - withoutImage).toBeLessThan(500);
  });

  test("image sub-block is NOT counted when is_error is true", () => {
    // The Anthropic serializer filters image parts out of error tool results
    // (client.ts:1398), so the estimator must match.
    const pngBase64 = makePngBase64(512, 512);
    const errorWithImage = estimateContentBlockTokens(
      {
        type: "tool_result",
        tool_use_id: "call_err",
        content: "operation failed",
        is_error: true,
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: pngBase64,
            },
          },
        ],
      },
      { providerName: "anthropic" },
    );
    const errorNoImage = estimateContentBlockTokens(
      {
        type: "tool_result",
        tool_use_id: "call_err",
        content: "operation failed",
        is_error: true,
      },
      { providerName: "anthropic" },
    );
    expect(errorWithImage).toBe(errorNoImage);
  });

  test("unknown sub-block types are NOT counted", () => {
    // The Anthropic serializer only forwards image/text sub-blocks. Anything
    // else (thinking, tool_use, etc.) is dropped — the estimator must not
    // add tokens for content that never reaches the wire.
    const withThinking = estimateContentBlockTokens({
      type: "tool_result",
      tool_use_id: "call_think",
      content: "done",
      contentBlocks: [
        {
          type: "thinking",
          thinking: "a".repeat(4000),
          signature: "sig_stub",
        },
      ],
    });
    const plain = estimateContentBlockTokens({
      type: "tool_result",
      tool_use_id: "call_think",
      content: "done",
    });
    expect(withThinking).toBe(plain);
  });

  test("text sub-block beyond block.content is counted once", () => {
    // Handlers (e.g. secret-detection) may populate contentBlocks with an
    // additional text entry distinct from block.content. The serializer
    // forwards both, so the estimator counts both — but this is not the
    // pre-fix 2x double-count where content was summed once for the string
    // and again for an echoing text sub-block.
    const extraText = "x".repeat(4000);
    const tokens = estimateContentBlockTokens({
      type: "tool_result",
      tool_use_id: "call_dual_text",
      content: "short summary",
      contentBlocks: [{ type: "text", text: extraText }],
    });
    // Estimate should be roughly:
    //   overhead + id + "short summary" + (text overhead + 1000 tokens for extraText)
    // The extra text is ~1000 tokens on its own; overhead is small.
    expect(tokens).toBeGreaterThan(1000);
    expect(tokens).toBeLessThan(1100);
  });

  test("regression: tool_result with thinking sub-block does not inflate estimate by 3x+", () => {
    // Simulates the pathological shape that was inflating the estimator on
    // real conversations — a modest tool_result whose contentBlocks happen
    // to carry a large sub-block the serializer discards. Prior to the fix
    // the estimator would add the full thinking payload; after the fix it
    // matches the plain shape.
    const content = "y".repeat(2000);
    const inflated = estimateContentBlockTokens({
      type: "tool_result",
      tool_use_id: "call_regress",
      content,
      contentBlocks: [
        { type: "thinking", thinking: "z".repeat(8000), signature: "s" },
      ],
    });
    const wireShape = estimateContentBlockTokens({
      type: "tool_result",
      tool_use_id: "call_regress",
      content,
    });
    expect(inflated).toBe(wireShape);
  });
});
