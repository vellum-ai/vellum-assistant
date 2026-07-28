/**
 * Tests for Content-Disposition filename parsing and the ASCII-safe
 * response headers that carry a filename to clients.
 *
 * Expected values are derived from the specs, not from the implementation:
 * - RFC 6266 §4.1/§4.3 (Content-Disposition, filename vs filename*)
 * - RFC 8187 §3.2 (ext-value: charset'lang'percent-encoded)
 * - RFC 9110 §5.5 (HTTP field values are US-ASCII)
 */

import { describe, expect, test } from "bun:test";

import {
  filenameResponseHeaders,
  parseContentDispositionFilename,
} from "../content-disposition.js";

describe("parseContentDispositionFilename", () => {
  test("reads a quoted filename parameter", () => {
    // GIVEN a header with a quoted filename
    const header = 'attachment; filename="invoice.pdf"';

    // WHEN it is parsed
    const filename = parseContentDispositionFilename(header);

    // THEN the quotes are stripped
    expect(filename).toBe("invoice.pdf");
  });

  test("reads an unquoted token filename", () => {
    // GIVEN a header whose filename is a bare token
    const header = "attachment; filename=invoice.pdf";

    // WHEN it is parsed
    const filename = parseContentDispositionFilename(header);

    // THEN the token is returned
    expect(filename).toBe("invoice.pdf");
  });

  test("decodes an RFC 8187 UTF-8 ext-value", () => {
    // GIVEN a spec-compliant filename* parameter
    const header = "attachment; filename*=UTF-8''caf%C3%A9%20menu.pdf";

    // WHEN it is parsed
    const filename = parseContentDispositionFilename(header);

    // THEN the percent-encoded UTF-8 is decoded, charset and language dropped
    expect(filename).toBe("café menu.pdf");
  });

  test("decodes an RFC 8187 ext-value carrying a language tag", () => {
    // GIVEN a filename* parameter with a language tag
    const header = "attachment; filename*=UTF-8'en'r%C3%A9sum%C3%A9.pdf";

    // WHEN it is parsed
    const filename = parseContentDispositionFilename(header);

    // THEN only the value part is returned
    expect(filename).toBe("résumé.pdf");
  });

  test("decodes an ISO-8859-1 ext-value", () => {
    // GIVEN a filename* parameter in the other charset RFC 8187 requires
    const header = "attachment; filename*=ISO-8859-1''caf%E9.pdf";

    // WHEN it is parsed
    const filename = parseContentDispositionFilename(header);

    // THEN the bytes are decoded as latin-1
    expect(filename).toBe("café.pdf");
  });

  test("prefers filename* over filename when both are present", () => {
    // GIVEN a header carrying both forms, as RFC 6266 §4.3 recommends
    const header =
      "attachment; filename=\"cafe.pdf\"; filename*=UTF-8''caf%C3%A9.pdf";

    // WHEN it is parsed
    const filename = parseContentDispositionFilename(header);

    // THEN the extended form wins
    expect(filename).toBe("café.pdf");
  });

  test("falls back to filename when the ext-value is undecodable", () => {
    // GIVEN a filename* in a charset that cannot be decoded
    const header =
      "attachment; filename=\"fallback.pdf\"; filename*=Shift_JIS''%82%A0.pdf";

    // WHEN it is parsed
    const filename = parseContentDispositionFilename(header);

    // THEN the plain parameter is used
    expect(filename).toBe("fallback.pdf");
  });

  test("keeps non-ASCII characters a provider sent unencoded", () => {
    // GIVEN a provider that put raw Unicode in the plain filename parameter
    const header = 'attachment; filename="Ben’s notes.txt"';

    // WHEN it is parsed
    const filename = parseContentDispositionFilename(header);

    // THEN the value is preserved verbatim
    expect(filename).toBe("Ben’s notes.txt");
  });

  test("reduces a path to its last segment", () => {
    // GIVEN a filename containing directory separators
    const header = 'attachment; filename="../../etc/passwd"';

    // WHEN it is parsed
    const filename = parseContentDispositionFilename(header);

    // THEN only the final segment survives
    expect(filename).toBe("passwd");
  });

  test("rejects a header with no usable filename", () => {
    // GIVEN headers that carry no filename, an empty one, or only dots
    // WHEN each is parsed
    // THEN nothing is returned so the caller can fall back
    expect(parseContentDispositionFilename("attachment")).toBeUndefined();
    expect(parseContentDispositionFilename("")).toBeUndefined();
    expect(
      parseContentDispositionFilename('attachment; filename=""'),
    ).toBeUndefined();
    expect(
      parseContentDispositionFilename('attachment; filename=".."'),
    ).toBeUndefined();
  });

  test("strips control characters, including header-splitting bytes", () => {
    // GIVEN a filename with an embedded CRLF
    const header = 'attachment; filename="evil\r\nx-injected: 1.pdf"';

    // WHEN it is parsed
    const filename = parseContentDispositionFilename(header);

    // THEN the control characters are removed
    expect(filename).toBe("evilx-injected: 1.pdf");
  });
});

describe("filenameResponseHeaders", () => {
  test("passes an ASCII filename through unchanged on both headers", () => {
    // GIVEN a plain ASCII filename
    // WHEN headers are built
    const headers = filenameResponseHeaders("invoice.pdf");

    // THEN both headers carry the name, the encoded one percent-encoded
    expect(headers["x-filename"]).toBe("invoice.pdf");
    expect(headers["x-filename-encoded"]).toBe("invoice.pdf");
  });

  test("keeps non-ASCII out of the header values", () => {
    // GIVEN a filename with a smart quote and an accent
    const filename = "Ben’s café.pdf";

    // WHEN headers are built
    const headers = filenameResponseHeaders(filename);

    // THEN every emitted byte is US-ASCII, as RFC 9110 §5.5 requires
    for (const value of Object.values(headers)) {
      // eslint-disable-next-line no-control-regex
      expect(value).toMatch(/^[\x20-\x7e]*$/);
    }

    // AND the encoded header round-trips back to the original filename
    expect(decodeURIComponent(headers["x-filename-encoded"])).toBe(filename);

    // AND the legacy header degrades to a readable ASCII approximation
    expect(headers["x-filename"]).toBe("Ben_s caf_.pdf");
  });
});
