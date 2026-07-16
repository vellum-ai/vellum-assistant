/**
 * Map a Vellum platform host onto its environment's velay host, following the
 * deployment naming convention (`platform.vellum.ai` → `velay.vellum.ai`,
 * `{env}-platform.vellum.ai` → `velay-{env}.vellum.ai`). Returns null for
 * hosts outside that convention (localhost, custom domains). Shared by the
 * gateway speech relay and the web live-voice client so the two ends of the
 * managed-speech transport can't drift.
 */
export function velayHostForPlatformHost(host: string): string | null {
  if (host === "platform.vellum.ai") {
    return "velay.vellum.ai";
  }
  const match = /^([a-z0-9-]+)-platform\.vellum\.ai$/.exec(host);
  return match ? `velay-${match[1]}.vellum.ai` : null;
}

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
