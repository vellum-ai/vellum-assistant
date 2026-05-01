export function normalizePublicBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeHttpPublicBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/[?#]/.test(trimmed)) return undefined;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    if (!url.hostname) return undefined;
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return undefined;
  }
}
