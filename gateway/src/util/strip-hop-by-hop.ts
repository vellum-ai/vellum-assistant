const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export function stripHopByHop(headers: Headers): Headers {
  const cleaned = new Headers(headers);

  // Also strip any headers listed in the Connection header value
  const connectionValue = cleaned.get("connection");
  if (connectionValue) {
    for (const name of connectionValue.split(",")) {
      const trimmed = name.trim().toLowerCase();
      if (trimmed) {
        try {
          cleaned.delete(trimmed);
        } catch {
          // Ignore invalid header names (e.g., malformed Connection tokens like "@@@")
        }
      }
    }
  }

  for (const h of HOP_BY_HOP_HEADERS) {
    cleaned.delete(h);
  }
  return cleaned;
}
