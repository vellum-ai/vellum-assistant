/**
 * Codec for Vellum-managed model routing strings.
 *
 * A single `vellum` provider connection is provider-agnostic: unlike the
 * per-provider `*-managed` connections it does not carry the upstream provider
 * on its DB row. The upstream provider therefore has to travel *with* the
 * model. Where a routing site has the provider as a sibling field it uses that
 * directly; where only a single model string is available (telemetry headers
 * like `X-Vellum-Resolved-Model`, persisted model overrides, display), the
 * provider is encoded as a `<provider>/<model>` prefix, e.g.
 * `fireworks/accounts/fireworks/models/minimax-m3`.
 *
 * This module is the single source of truth for that encoding. It is a pure
 * codec — no I/O, no wiring — so it can be adopted incrementally.
 */

import { PLATFORM_PROVIDER_META } from "./platform-proxy/constants.js";

/**
 * Provider ids that can front a Vellum-managed (platform-proxied) route.
 * Only these are valid prefixes for a routing string; everything else
 * (openrouter, ollama, openai-compatible, or a raw native model id) is not a
 * Vellum-routed string and `parseVellumModel` returns null for it.
 */
export const MANAGED_ROUTABLE_PROVIDERS: ReadonlySet<string> = new Set(
  Object.values(PLATFORM_PROVIDER_META)
    .filter((m) => m.managed)
    .map((m) => m.name),
);

/**
 * Sentinel provider id for the single, provider-agnostic Vellum-managed
 * connection. Unlike the per-provider `*-managed` connections, this one does
 * not name an upstream provider on its DB row — the upstream is determined
 * per-request from the resolving profile. This id is never a real catalog
 * entry, so routing code must substitute the effective provider before any
 * catalog/adapter lookup.
 */
export const VELLUM_MANAGED_PROVIDER = "vellum";

/**
 * Whether a connection is the provider-agnostic Vellum-managed connection.
 * Structurally typed so this stays a pure module with no connection-schema
 * import.
 */
export function isVellumManagedConnection(conn: {
  provider: string;
  auth: { type: string };
}): boolean {
  return (
    conn.provider === VELLUM_MANAGED_PROVIDER && conn.auth.type === "platform"
  );
}

export interface VellumModelRoute {
  /** Upstream provider id, e.g. "fireworks". Always a managed-routable id. */
  provider: string;
  /** Native upstream model id, slashes intact, e.g. "accounts/fireworks/models/minimax-m3". */
  model: string;
}

/**
 * Encode a provider + native model id into a Vellum routing string.
 * Throws on a non-routable provider — that is a caller bug, not user input.
 */
export function formatVellumModel(provider: string, model: string): string {
  if (!MANAGED_ROUTABLE_PROVIDERS.has(provider)) {
    throw new Error(
      `formatVellumModel: "${provider}" is not a Vellum-managed provider ` +
        `(expected one of ${[...MANAGED_ROUTABLE_PROVIDERS].join(", ")})`,
    );
  }
  if (!model) {
    throw new Error("formatVellumModel: model must be non-empty");
  }
  return `${provider}/${model}`;
}

/**
 * Decode a Vellum routing string back into provider + native model id.
 *
 * Splits on the FIRST slash only so native ids that themselves contain
 * slashes (Fireworks `accounts/fireworks/models/...`) round-trip losslessly.
 * Returns null when the string is not a Vellum-routed model — no slash, empty
 * model, or a prefix that is not a managed-routable provider.
 *
 * Note: `anthropic/…` is also OpenRouter's native id shape, so this codec
 * must only be applied in a Vellum-connection context. OpenRouter is
 * `managed:false` and never routes through a vellum connection, so the
 * collision is unreachable in practice; the guard here is belt-and-suspenders.
 */
export function parseVellumModel(
  routingString: string,
): VellumModelRoute | null {
  const slash = routingString.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  const provider = routingString.slice(0, slash);
  const model = routingString.slice(slash + 1);
  if (!model) {
    return null;
  }
  if (!MANAGED_ROUTABLE_PROVIDERS.has(provider)) {
    return null;
  }
  return { provider, model };
}
