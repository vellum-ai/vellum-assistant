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

/**
 * The same validation as `normalizeHttpPublicBaseUrl`, minus the root path it
 * always emits (`https://x` becomes `https://x/`). Callers that append a path
 * or persist the result want this shape, so they neither join through a double
 * slash nor re-strip what the normalizer just added.
 */
export function normalizeHttpPublicBaseUrlWithoutTrailingSlash(
  value: unknown,
): string | undefined {
  return normalizePublicBaseUrl(normalizeHttpPublicBaseUrl(value));
}

/**
 * A trimmed string, or undefined when the value is not a non-blank string.
 *
 * Exported because the identity check in the daemon's tunnel probe compares an
 * id recorded here against one an edge serves, and the two sides have to trim
 * alike: a padded served id must read as a match, not as a different
 * assistant.
 */
export function trimmedNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Records `vellum tunnel` leaves in the workspace config's `ingress` section.
// The CLI writes them and the daemon reads them, and the two are separate
// build units that cannot import each other, so the key names, the provider
// allowlist, and the validation all live here rather than in a copy on each
// side.

/** Key under `ingress` holding the tunnel that most recently ran. */
export const INGRESS_LAST_TUNNEL_KEY = "lastTunnel";

/**
 * Key under `ingress` holding a tunnel published for device pairing alone.
 *
 * A tailnet-only tunnel started while webhook integrations are configured
 * cannot carry their callbacks, so it leaves `publicBaseUrl` (the callback
 * base) as it is and records itself here. Readers that answer the pairing card
 * prefer this address over `publicBaseUrl`; teardown drops the key.
 */
export const INGRESS_PAIRING_TUNNEL_KEY = "pairingTunnel";

/** Key under `ingress` holding the assistant id that tunnel fronted. */
export const INGRESS_ASSISTANT_ID_KEY = "assistantId";

/**
 * The local tunnel providers the CLI can start, in the order they are offered.
 * `vellum tunnel`'s accepted `--provider` values and the persisted-record
 * validation below both derive from it.
 */
export const TUNNEL_PROVIDERS = ["ngrok", "cloudflare", "tailscale"] as const;

export type TunnelProviderName = (typeof TUNNEL_PROVIDERS)[number];

/** A recorded tunnel, kept after teardown so UIs can name the command to restart. */
export interface TunnelRecord {
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
 * Parse an `ingress.lastTunnel` or `ingress.pairingTunnel` value, or null when
 * it is absent or malformed.
 *
 * A hand-edited config must not hand callers an unusable address or a provider
 * name no command accepts: the provider is checked against the allowlist
 * because readers render it into a restart command, and the URL faces the same
 * absolute HTTP(S) constraint as every other public base URL. The URL comes
 * back in the shape the validator produced, so readers never re-normalize it.
 */
export function parseTunnelRecord(value: unknown): TunnelRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { provider, publicBaseUrl } = value as Record<string, unknown>;
  if (!isTunnelProviderName(provider)) {
    return null;
  }
  const normalized =
    normalizeHttpPublicBaseUrlWithoutTrailingSlash(publicBaseUrl);
  if (normalized === undefined) {
    return null;
  }
  return { provider, publicBaseUrl: normalized };
}

/** Parse an `ingress.assistantId` value, or null when it is absent or blank. */
export function parseRecordedAssistantId(value: unknown): string | null {
  return trimmedNonEmptyString(value) ?? null;
}
