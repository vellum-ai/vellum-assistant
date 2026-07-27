/**
 * Byte-range serving for routes that hand back file content.
 *
 * Callers own resolving and authorizing the path; this owns the HTTP shape of
 * the reply — parsing the `Range` header, slicing, and setting `Content-Range`
 * / `Accept-Ranges` / `Content-Length`.
 *
 * Status codes are split between here and the route definition, deliberately.
 * A route that supports ranges declares
 * `responseStatus: ({ headers }) => (headers?.["range"] ? "206" : "200")`, so
 * the presence of the request header decides 206 vs 200 without the handler
 * saying anything. This function overrides that only for the one case the
 * route-level callable cannot see: a `Range` header arrived but was
 * unparseable, so the reply is the whole file at 200 rather than a partial at
 * 206. An out-of-bounds range throws `RangeNotSatisfiableError` (416).
 *
 * See [RFC 9110 §14 — Range Requests](https://httpwg.org/specs/rfc9110.html#range.requests).
 */

import { RangeNotSatisfiableError } from "./errors.js";
import { RouteResponse } from "./types.js";

export interface FileRangeRequest {
  /**
   * The complete file. Sliced when a range is requested, so this should be a
   * lazy handle (`Bun.file(...)`) rather than buffered bytes — a slice of a
   * `BunFile` reads only the requested window off disk.
   */
  file: Blob;
  /**
   * Total size of `file` in bytes. Passed in rather than read off `file.size`
   * because callers may hold an authoritative size from their own metadata.
   */
  sizeBytes: number;
  mimeType: string;
  /** Raw `Range` request header, when the client sent one. */
  rangeHeader?: string;
}

/** Parsed byte window, or `null` when the header is not one we understand. */
function parseByteRange(
  rangeHeader: string,
  sizeBytes: number,
): { start: number; end: number } | null {
  // Suffix form (`bytes=-500`): the last N bytes.
  const suffixMatch = rangeHeader.match(/bytes=-(\d+)/);
  if (suffixMatch) {
    const suffixLength = parseInt(suffixMatch[1]);
    return {
      start: Math.max(0, sizeBytes - suffixLength),
      end: sizeBytes - 1,
    };
  }

  // Explicit form (`bytes=0-1023`, or `bytes=1024-` for open-ended).
  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!match) {
    return null;
  }
  return {
    start: parseInt(match[1]),
    end: match[2] ? parseInt(match[2]) : sizeBytes - 1,
  };
}

/**
 * Build the response for a file-content request, honoring `Range`.
 *
 * @throws {RangeNotSatisfiableError} when the requested window starts past the
 * end of the file, or is inverted.
 */
export function fileRangeResponse({
  file,
  sizeBytes,
  mimeType,
  rangeHeader,
}: FileRangeRequest): RouteResponse {
  const wholeFileHeaders = {
    "Content-Type": mimeType,
    "Content-Length": String(sizeBytes),
    "Accept-Ranges": "bytes",
  };

  if (!rangeHeader) {
    return new RouteResponse(file, wholeFileHeaders);
  }

  const requested = parseByteRange(rangeHeader, sizeBytes);
  if (!requested) {
    // The route-level status callable saw a `Range` header and resolved 206;
    // an unparseable one means the whole file, so correct it back to 200.
    return new RouteResponse(file, wholeFileHeaders, 200);
  }

  const { start } = requested;
  const end = Math.min(requested.end, sizeBytes - 1);

  if (start > end || start >= sizeBytes) {
    throw new RangeNotSatisfiableError(`bytes */${sizeBytes}`);
  }

  return new RouteResponse(file.slice(start, end + 1), {
    "Content-Type": mimeType,
    "Content-Range": `bytes ${start}-${end}/${sizeBytes}`,
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
  });
}
