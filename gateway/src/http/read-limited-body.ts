export type ReadLimitedBodyResult =
  | { status: "ok"; text: string }
  | { status: "too_large" }
  | { status: "unreadable" };

export async function readLimitedBody(
  req: Request,
  maxBytes: number,
): Promise<ReadLimitedBodyResult> {
  const contentLength = req.headers.get("content-length");
  if (
    contentLength &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > maxBytes
  ) {
    return { status: "too_large" };
  }

  if (!req.body) return { status: "ok", text: "" };

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

  return { status: "ok", text: new TextDecoder().decode(bytes) };
}
