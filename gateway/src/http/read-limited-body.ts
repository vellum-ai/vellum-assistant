export type ReadLimitedBodyResult =
  | { status: "ok"; text: string }
  | { status: "too_large" }
  | { status: "unreadable" };

export type ReadLimitedBodyBytesResult =
  | { status: "ok"; bytes: Uint8Array<ArrayBuffer> }
  | { status: "too_large" }
  | { status: "unreadable" };

/**
 * Read a request body into memory while enforcing a hard byte cap as the
 * stream arrives. Unlike a Content-Length header check, this bounds the bytes
 * actually buffered even when the header is absent, spoofed, or the request
 * uses chunked transfer-encoding — so it is safe to call on unauthenticated
 * ingress before any signature check.
 */
export async function readLimitedBodyBytes(
  req: Request,
  maxBytes: number,
): Promise<ReadLimitedBodyBytesResult> {
  const contentLength = req.headers.get("content-length");
  if (
    contentLength &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > maxBytes
  ) {
    return { status: "too_large" };
  }

  if (!req.body) return { status: "ok", bytes: new Uint8Array(0) };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return { status: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { status: "unreadable" };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { status: "ok", bytes };
}

export async function readLimitedBody(
  req: Request,
  maxBytes: number,
): Promise<ReadLimitedBodyResult> {
  const result = await readLimitedBodyBytes(req, maxBytes);
  if (result.status !== "ok") return result;
  return { status: "ok", text: new TextDecoder().decode(result.bytes) };
}
