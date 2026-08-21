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

// Records `vellum tunnel` leaves in the workspace config's `ingress` section.
// The CLI writes them and the daemon reads them, and the two are separate
// build units that cannot import each other, so the key names, the provider
// allowlist, and the validation all live here rather than in a copy on each
// side.

/** Key under `ingress` holding the tunnel that most recently ran. */
export const INGRESS_LAST_TUNNEL_KEY = "lastTunnel";

/** Key under `ingress` holding the assistant id that tunnel fronted. */
export const INGRESS_ASSISTANT_ID_KEY = "assistantId";

/**
 * The local tunnel providers the CLI can start, in the order they are offered.
 * `vellum tunnel`'s accepted `--provider` values and the persisted-record
 * validation below both derive from it.
 */
export const TUNNEL_PROVIDERS = ["ngrok", "cloudflare", "tailscale"] as const;

export type TunnelProviderName = (typeof TUNNEL_PROVIDERS)[number];

/** The tunnel that most recently ran, kept after teardown so UIs can name the command to restart. */
export interface LastTunnelRecord {
  provider: TunnelProviderName;
  publicBaseUrl: string;
}

function isTunnelProviderName(value: unknown): value is TunnelProviderName {
  return (
    typeof value === "string" &&
    (TUNNEL_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Parse an `ingress.lastTunnel` value, or null when it is absent or malformed.
 *
 * A hand-edited config must not hand callers an unusable address or a provider
 * name no command accepts: the provider is checked against the allowlist
 * because readers render it into a restart command, and the URL faces the same
 * absolute HTTP(S) constraint as every other public base URL.
 */
export function parseLastTunnelRecord(value: unknown): LastTunnelRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { provider, publicBaseUrl } = value as Record<string, unknown>;
  if (!isTunnelProviderName(provider) || typeof publicBaseUrl !== "string") {
    return null;
  }
  if (!normalizeHttpPublicBaseUrl(publicBaseUrl)) {
    return null;
  }
  return { provider, publicBaseUrl: publicBaseUrl.trim() };
}

/** Parse an `ingress.assistantId` value, or null when it is absent or blank. */
export function parseRecordedAssistantId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
