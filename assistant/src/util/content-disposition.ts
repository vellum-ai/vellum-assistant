/**
 * Parsing and safe transport of attachment filenames.
 *
 * Filenames originate from third parties (a mail provider echoing whatever
 * the sender named their attachment), so they may contain any Unicode
 * codepoint. HTTP field values are restricted to US-ASCII
 * (RFC 9110 §5.5 — https://httpwg.org/specs/rfc9110.html#fields.values), and
 * the standard escape hatch for `Content-Disposition` (RFC 6266 §4.3 —
 * https://httpwg.org/specs/rfc6266.html#advice.generating) does not exist for
 * custom headers. Non-ASCII therefore has to be encoded explicitly.
 */

/** Characters that are safe to emit verbatim in an HTTP field value. */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * Decode an RFC 8187 ext-value — `charset "'" [language] "'" value-chars`
 * (https://httpwg.org/specs/rfc8187.html#encoding) — as produced by a
 * spec-compliant `filename*` parameter.
 */
function decodeExtValue(raw: string): string | undefined {
  const match = /^([^']*)'([^']*)'(.*)$/.exec(raw);
  if (!match) return undefined;

  const charset = (match[1] || "utf-8").toLowerCase();
  const encoded = match[3];

  try {
    if (charset === "utf-8") return decodeURIComponent(encoded);
    if (charset === "iso-8859-1") {
      return encoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Reduce a filename to a single path segment with no control characters,
 * so a hostile upstream value cannot escape the directory a consumer
 * writes into.
 */
function sanitizeFilename(value: string): string | undefined {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split(/[/\\]/)
    .pop()
    ?.trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return undefined;
  return cleaned;
}

/**
 * Extract the filename from a `Content-Disposition` header value.
 *
 * `filename*` wins over `filename` when both are present, per RFC 6266 §4.3.
 */
export function parseContentDispositionFilename(
  header: string,
): string | undefined {
  if (!header) return undefined;

  const extended = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/i.exec(header);
  if (extended) {
    const decoded = decodeExtValue(extended[1].trim().replace(/^"|"$/g, ""));
    if (decoded) {
      const sanitized = sanitizeFilename(decoded);
      if (sanitized) return sanitized;
    }
  }

  const plain = /(?:^|;)\s*filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/i.exec(
    header,
  );
  if (plain) {
    const raw = plain[1].trim();
    const unquoted = raw.startsWith('"')
      ? raw.slice(1, -1).replace(/\\(.)/g, "$1")
      : raw;
    const sanitized = sanitizeFilename(unquoted);
    if (sanitized) return sanitized;
  }

  return undefined;
}

/**
 * Build the response headers that carry an arbitrary-Unicode filename to
 * clients of the custom `x-filename` header.
 *
 * `x-filename-encoded` is the authoritative value: percent-encoded UTF-8,
 * always ASCII, decoded with `decodeURIComponent`. `x-filename` stays for
 * clients that predate the encoded header and is mangled down to ASCII —
 * emitting the raw value there would put non-ASCII bytes on the wire, which
 * proxies and HTTP stacks reject.
 */
export function filenameResponseHeaders(
  filename: string,
): Record<string, string> {
  const ascii = PRINTABLE_ASCII.test(filename)
    ? filename
    : filename.replace(/[^\x20-\x7e]/g, "_");

  return {
    "x-filename": ascii,
    "x-filename-encoded": encodeURIComponent(filename),
  };
}
