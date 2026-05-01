export function normalizePublicBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : undefined;
}
