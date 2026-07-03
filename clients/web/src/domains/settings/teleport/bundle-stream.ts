/**
 * Read a response body into an `ArrayBuffer`, reporting progress (0..1) when the
 * server sends a `Content-Length`. Shared by the platform signed-URL download
 * and the local gateway export, which both stream `.vbundle` bytes.
 */
export async function readArrayBufferWithProgress(
  response: Response,
  onProgress?: (fraction: number) => void,
): Promise<ArrayBuffer> {
  const total = Number(response.headers.get("Content-Length") ?? 0);
  if (!response.body || !onProgress || total <= 0) {
    const bytes = await response.arrayBuffer();
    onProgress?.(1);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / total);
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  onProgress(1);
  return out.buffer;
}
