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

/**
 * Application close code the gateway's velay bridge sends to proxied
 * WebSockets when the tunnel itself is lost (velay disconnect, gateway
 * shutdown). A dedicated code because the natural 1001 (going away) cannot
 * be sent through the JS `close()` API (the bridge would remap it to a
 * misleading 4001), and Bun's WebSocket client drops close reasons, so the
 * code is the only signal that survives the relay to the daemon.
 */
export const GATEWAY_TUNNEL_LOST_WS_CLOSE_CODE = 4801;

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
