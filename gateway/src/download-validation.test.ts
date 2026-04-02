import { describe, expect, test } from "bun:test";
import {
  ContentMismatchError,
  validateDownloadedContent,
} from "./download-validation.js";

/** Create a minimal valid PNG buffer that file-type can detect. */
function makePngBuffer(): Uint8Array {
  return new Uint8Array([
    // PNG signature
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    // IHDR chunk: length (13)
    0x00, 0x00, 0x00, 0x0d,
    // IHDR type
    0x49, 0x48, 0x44, 0x52,
    // Width: 1
    0x00, 0x00, 0x00, 0x01,
    // Height: 1
    0x00, 0x00, 0x00, 0x01,
    // Bit depth, color type, compression, filter, interlace
    0x08, 0x02, 0x00, 0x00, 0x00,
    // CRC (placeholder)
    0x90, 0x77, 0x53, 0xde,
  ]);
}

function htmlBuffer(html: string): Uint8Array {
  return new TextEncoder().encode(html);
}

describe("validateDownloadedContent", () => {
  test("throws ContentMismatchError when HTML is received instead of image/png", async () => {
    const buffer = htmlBuffer(
      "<!DOCTYPE html><html><body><h1>Access Denied</h1></body></html>",
    );

    await expect(
      validateDownloadedContent(buffer, "image/png", "F001"),
    ).rejects.toThrow(ContentMismatchError);

    await expect(
      validateDownloadedContent(buffer, "image/png", "F001"),
    ).rejects.toThrow(
      "File F001 declared as image/png but content is HTML (likely an auth/error page)",
    );
  });

  test("throws ContentMismatchError for HTML with leading whitespace and BOM", async () => {
    // UTF-8 BOM (EF BB BF) + whitespace + HTML
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const html = new TextEncoder().encode(
      "  \n  <!DOCTYPE html><html><body>Error</body></html>",
    );
    const buffer = new Uint8Array(bom.length + html.length);
    buffer.set(bom, 0);
    buffer.set(html, bom.length);

    await expect(
      validateDownloadedContent(buffer, "image/jpeg", "F002"),
    ).rejects.toThrow(ContentMismatchError);
  });

  test("passes for valid PNG buffer with declared image/png", async () => {
    const buffer = makePngBuffer();

    // Should not throw
    await validateDownloadedContent(buffer, "image/png", "F003");
  });

  test("passes for valid PNG buffer with declared image/jpeg (same image family)", async () => {
    const buffer = makePngBuffer();

    // file-type detects it as image/png, which still starts with "image/"
    // so it should pass even though declared as image/jpeg
    await validateDownloadedContent(buffer, "image/jpeg", "F004");
  });

  test("passes for plain text buffer with declared text/plain (non-binary)", async () => {
    const buffer = new TextEncoder().encode("hello world");

    // text/plain is not a binary MIME type, so no validation is performed
    await validateDownloadedContent(
      new Uint8Array(buffer),
      "text/plain",
      "F005",
    );
  });

  test("passes for empty buffer with declared image/png", async () => {
    const buffer = new Uint8Array(0);

    // Empty buffer: looksLikeHtml returns false, fileTypeFromBuffer returns
    // undefined, so we allow it through and let downstream handle it
    await validateDownloadedContent(buffer, "image/png", "F006");
  });
});
