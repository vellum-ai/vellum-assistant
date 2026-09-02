import { describe, expect, test } from "bun:test";

import {
  clampProviderString,
  exceedsProviderStringCap,
  extractedTextForFileBlock,
  isVideoMimeType,
  MAX_PROVIDER_STRING_BYTES,
  PROVIDER_STRING_OMITTED_NOTE,
  utf8ByteLength,
} from "./content-block-size.js";

describe("content-block-size", () => {
  test("counts UTF-8 bytes, not JS string length", () => {
    expect(utf8ByteLength("é")).toBe(2);
    expect(exceedsProviderStringCap("é".repeat(4), 7)).toBe(true);
    expect(exceedsProviderStringCap("é".repeat(3), 7)).toBe(false);
  });

  test("default cap is under OpenAI's 10 MiB per-part limit", () => {
    expect(MAX_PROVIDER_STRING_BYTES).toBe(8_000_000);
    expect(MAX_PROVIDER_STRING_BYTES).toBeLessThan(10_485_760);
  });

  test("treats video MIME types, including parameters, as video", () => {
    expect(isVideoMimeType("video/mp4")).toBe(true);
    expect(isVideoMimeType("VIDEO/WEBM; codecs=vp9")).toBe(true);
    expect(isVideoMimeType("application/pdf")).toBe(false);
  });

  test("drops extracted_text for video and for over-cap extracts", () => {
    expect(
      extractedTextForFileBlock("video/mp4", "anything at all"),
    ).toBeUndefined();
    expect(extractedTextForFileBlock("application/pdf", "hello")).toBe("hello");
    expect(
      extractedTextForFileBlock("text/plain", "abcdef", 4),
    ).toBeUndefined();
  });

  test("clampProviderString replaces an over-cap string", () => {
    expect(clampProviderString("ok")).toBe("ok");
    expect(clampProviderString("abcdef", 4)).toBe(PROVIDER_STRING_OMITTED_NOTE);
  });
});
