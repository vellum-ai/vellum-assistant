/**
 * Canonical catalog of built-in web-fetch providers.
 *
 * This is the single source of truth that drives the config-schema enum
 * (`VALID_WEB_FETCH_PROVIDERS` in `assistant/src/config/schemas/services.ts`)
 * and the client picker mirror in
 * `clients/web/src/assistant/generated/web-fetch-provider-catalog.gen.ts`.
 *
 * Mirrors `search-provider-catalog.ts`. Where web-search distinguishes
 * `managed` (platform proxy) from `byok` (user key), web-fetch has no managed
 * proxy yet, so the two kinds are:
 *
 *   - `builtin` — the daemon's own HTTP fetch + extract path (`default`). No
 *     key, always available, the default.
 *   - `byok`    — an external provider that needs a user-supplied key (e.g.
 *     `firecrawl`, which scrapes via its hosted API and returns clean
 *     markdown, including for JavaScript-rendered pages the builtin fetcher
 *     can't see).
 *
 * BYOK fetch providers intentionally reuse the SAME bare-name credential as
 * their search counterpart (e.g. `firecrawl` → `FIRECRAWL_API_KEY`), so a
 * single stored key powers both `web_search` and `web_fetch`. The key is
 * already registered in `API_KEY_PROVIDERS` via `SEARCH_PROVIDER_CATALOG`;
 * this catalog deliberately does NOT re-register it.
 */

export type FetchProviderKind = "builtin" | "byok";

export interface FetchProviderCatalogEntry {
  /** Stable provider identifier. Matches config values. */
  readonly id: string;
  /** Short display name used by picker UIs. */
  readonly displayName: string;
  /** Optional long display name for prose contexts. */
  readonly displayNameLong?: string;
  /** `builtin` (no key) or `byok` (user-supplied key). */
  readonly kind: FetchProviderKind;
  /** Placeholder shown in the API-key input. BYOK providers only. */
  readonly apiKeyPrefix?: string;
  /** Environment variable name carrying the API key. BYOK providers only. */
  readonly envVar?: string;
  /** Secret-catalog key (the bare provider name accepted by
   *  `getProviderKeyAsync`). BYOK providers only. */
  readonly secretKey?: string;
  /** Privacy-policy URL surfaced in marketing data-sharing docs.
   *  BYOK providers only. */
  readonly privacyPolicyUrl?: string;
}

export const FETCH_PROVIDER_CATALOG: readonly FetchProviderCatalogEntry[] = [
  {
    id: "default",
    // Display-only: fetching runs in the daemon, not through the platform
    // proxy. The id stays `default` until a managed fetch route exists.
    displayName: "Vellum",
    displayNameLong: "Vellum built-in fetcher",
    kind: "builtin",
  },
  {
    id: "firecrawl",
    displayName: "Firecrawl",
    kind: "byok",
    apiKeyPrefix: "fc-...",
    envVar: "FIRECRAWL_API_KEY",
    secretKey: "firecrawl",
    privacyPolicyUrl: "https://www.firecrawl.dev/privacy-policy",
  },
];

/** Provider ids accepted by the web-fetch config schema. */
export const FETCH_PROVIDER_IDS: readonly string[] =
  FETCH_PROVIDER_CATALOG.map((p) => p.id);

/** Catalog entries that require a user-supplied API key. */
export const BYOK_FETCH_PROVIDERS: readonly FetchProviderCatalogEntry[] =
  FETCH_PROVIDER_CATALOG.filter((p) => p.kind === "byok");

/** BYOK fetch-provider ids. */
export const BYOK_FETCH_PROVIDER_IDS: readonly string[] =
  BYOK_FETCH_PROVIDERS.map((p) => p.id);

/** Look up a single catalog entry by id. Returns `undefined` if unknown. */
export function getFetchProvider(
  id: string,
): FetchProviderCatalogEntry | undefined {
  return FETCH_PROVIDER_CATALOG.find((p) => p.id === id);
}
