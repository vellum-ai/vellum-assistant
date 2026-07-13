/**
 * Read the curated plugin marketplace manifest from the canonical repo.
 *
 * The manifest at `plugins/marketplace.json` whitelists external
 * ecosystem plugins so they appear in `assistant plugins search` / the web
 * catalog and become installable by name. Its shape is a subset of the
 * Claude Code marketplace manifest
 * (https://code.claude.com/docs/en/plugin-marketplaces) — `name` + `owner` +
 * a `plugins` array where each entry carries a `name` and a `source`. Only
 * `github` sources are resolved today.
 *
 * The manifest is fetched from the repo at a git ref (via the GitHub Contents
 * API) rather than bundled into the assistant build — so the whitelist can
 * grow without shipping a new release.
 * Every external source pins an explicit `ref` that MUST be a full commit SHA:
 * the fetched code is locked to an immutable revision. Tags and branches are
 * rejected because they are mutable — an upstream owner could retag/repoint
 * them to attacker code that the daemon would then `import()` (the install
 * tree is dynamically loaded). A SHA cannot be repointed, so the reviewed
 * manifest fully determines what gets executed.
 *
 * Designed for direct programmatic use with an injected `fetch`, mirroring
 * {@link ./search-plugins} and {@link ./install-from-github}.
 */

import { z } from "zod";

import type { FetchLike } from "./fetch-like.js";

/** Canonical location of the marketplace manifest. */
const MARKETPLACE_SOURCE_OWNER = "vellum-ai";
const MARKETPLACE_SOURCE_REPO = "vellum-assistant";
const MARKETPLACE_FILE_PATH = "plugins/marketplace.json";

/**
 * Canonical GitHub coordinates of the marketplace manifest, exported so
 * sibling readers (e.g. {@link ./plugin-pin-history}) resolve the same
 * `owner/repo:path` rather than re-declaring it.
 */
export const MARKETPLACE_MANIFEST_LOCATION = {
  owner: MARKETPLACE_SOURCE_OWNER,
  repo: MARKETPLACE_SOURCE_REPO,
  path: MARKETPLACE_FILE_PATH,
} as const;

// ---------------------------------------------------------------------------
// Manifest schema (subset of the Claude Code marketplace schema)
// ---------------------------------------------------------------------------

/** `owner/repo`, kebab/underscore/dot segments — matches GitHub's slug rules. */
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** Install name: a single kebab-case path segment (same rule as the CLI). */
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
/**
 * Full Git commit SHA — 40 hex chars (SHA-1) or 64 (SHA-256). External
 * marketplace refs must be a complete object name so the install is pinned to
 * an immutable revision; abbreviated SHAs, tags, and branches are all mutable
 * or ambiguous and are rejected.
 */
const COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export const githubSourceSchema = z.object({
  /** Discriminator. Only GitHub sources are resolved today. */
  source: z.literal("github"),
  /** `owner/repo` of the external plugin repository. */
  repo: z.string().regex(REPO_SLUG_RE, "expected an `owner/repo` slug"),
  /**
   * Directory within the repo that holds the plugin root. Omitted / empty
   * means the repository root. Must not escape the repo.
   */
  path: z
    .string()
    .refine(
      (p) => !p.split(/[/\\]/).some((seg) => seg === ".." || seg === ""),
      "path must be a clean repo-relative directory",
    )
    .optional(),
  /**
   * Immutable revision to fetch the plugin from. Must be a full commit SHA:
   * tags and branches are mutable, so allowing them would let an upstream
   * owner retarget a curated entry at code the daemon later `import()`s (RCE).
   * A full SHA pins the install to exactly the reviewed bytes.
   */
  ref: z
    .string()
    .regex(
      COMMIT_SHA_RE,
      "expected a full commit SHA (40 or 64 hex chars); tags and branches are mutable and not allowed",
    ),
});

const marketplaceEntrySchema = z.object({
  /** Install name. `assistant plugins install <name>` resolves to this entry. */
  name: z.string().regex(PLUGIN_NAME_RE, "expected a kebab-case install name"),
  source: githubSourceSchema,
  description: z.string().optional(),
  /** Free-form grouping hint (e.g. `productivity`). Informational. */
  category: z.string().optional(),
  homepage: z.string().optional(),
  license: z.string().optional(),
  /**
   * A single curated author/curator emoji shown as the plugin's icon (e.g. on
   * the marketing catalog). Not a URL or file path — bounded to a short
   * emoji-length string; a multi-code-point emoji (skin tone, ZWJ sequence)
   * still fits comfortably under the cap.
   */
  icon: z
    .string()
    .refine(
      (s) => s.length <= 8 && !/[/\\]|^https?:/i.test(s),
      "expected a short emoji, not a URL or path",
    )
    .optional(),
});

export const marketplaceManifestSchema = z.object({
  name: z.string(),
  owner: z
    .object({
      name: z.string(),
      url: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
  plugins: z.array(marketplaceEntrySchema),
});

/** A single whitelisted external plugin entry. */
export type MarketplaceEntry = z.infer<typeof marketplaceEntrySchema>;

/** Concrete GitHub coordinates an entry resolves to for install. */
export interface ResolvedPluginSource {
  readonly owner: string;
  readonly repo: string;
  /** Directory within the repo holding the plugin root; `""` = repo root. */
  readonly path: string;
  /** Git ref to fetch from. */
  readonly ref: string;
}

/** Options controlling which marketplace revision to read. */
export interface FetchMarketplaceOptions {
  /** Ref of the canonical repo to read the manifest from. */
  readonly ref: string;
}

/** Dependencies injected by the caller. */
export interface FetchMarketplaceDeps {
  /** HTTP client. Production callers pass `globalThis.fetch.bind(globalThis)`. */
  readonly fetch: FetchLike;
}

/**
 * The manifest could not be read or did not validate. Distinct from "no
 * manifest at this ref" (a missing file is a normal, empty result) — this
 * signals an upstream/parse problem the caller must surface.
 *
 * `transient` distinguishes a retryable upstream hiccup (GitHub rate-limited
 * us or returned a 5xx) from a hard failure (a malformed or invalid manifest).
 * The catalog is the source of truth for installable plugins, so a transient
 * fetch failure should map to a retryable 503 and serve a stale cache, while a
 * hard failure surfaces as a real error.
 */
export class MarketplaceFetchError extends Error {
  /** Whether the failure is a retryable upstream hiccup vs a hard error. */
  readonly transient: boolean;
  /** Upstream HTTP status, when the failure originated from a response. */
  readonly status?: number;
  constructor(
    message: string,
    opts?: { transient?: boolean; status?: number },
  ) {
    super(message);
    this.name = "MarketplaceFetchError";
    this.transient = opts?.transient ?? false;
    if (opts?.status !== undefined) this.status = opts.status;
  }
}

/**
 * Classify an upstream GitHub status as transient (worth retrying) vs hard.
 * A 429 or 5xx is always transient. A 403 is GitHub's unauthenticated
 * rate-limit signal only when the remaining-quota header is exhausted — a 403
 * without it is a genuine authorization failure and stays hard.
 */
function isTransientUpstreamStatus(res: Response): boolean {
  if (res.status === 429 || res.status >= 500) return true;
  if (res.status === 403) {
    return res.headers.get("x-ratelimit-remaining") === "0";
  }
  return false;
}

/**
 * Fetch and validate the marketplace manifest, returning its plugin entries.
 *
 * A missing manifest (HTTP 404) is treated as an empty whitelist — an empty
 * catalog is a valid state, not an error. Any other HTTP failure, a non-JSON
 * body, or a schema violation throws {@link MarketplaceFetchError}; a
 * rate-limit or 5xx is flagged `transient` so the caller can retry.
 */
export async function fetchMarketplaceEntries(
  deps: FetchMarketplaceDeps,
  opts: FetchMarketplaceOptions,
): Promise<readonly MarketplaceEntry[]> {
  const { ref } = opts;
  const url =
    `https://api.github.com/repos/${MARKETPLACE_SOURCE_OWNER}/${MARKETPLACE_SOURCE_REPO}` +
    `/contents/${MARKETPLACE_FILE_PATH}?ref=${encodeURIComponent(ref)}`;

  const res = await deps.fetch(url, {
    headers: {
      // Ask for the raw file body rather than the base64-wrapped Contents
      // envelope, so the response text is the manifest JSON directly.
      Accept: "application/vnd.github.raw",
      "User-Agent": "vellum-assistant-cli",
    },
  });

  if (res.status === 404) return [];
  if (!res.ok) {
    throw new MarketplaceFetchError(
      `Marketplace manifest fetch failed for ${MARKETPLACE_FILE_PATH} @ ${ref}: HTTP ${res.status}`,
      { transient: isTransientUpstreamStatus(res), status: res.status },
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch (err) {
    throw new MarketplaceFetchError(
      `Marketplace manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = marketplaceManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new MarketplaceFetchError(
      `Marketplace manifest failed validation: ${parsed.error.message}`,
    );
  }

  return parsed.data.plugins;
}

/**
 * Resolve a plugin name to concrete GitHub coordinates using the supplied
 * marketplace entries. Returns `null` when no entry claims the name.
 */
export function resolveMarketplaceSource(
  name: string,
  entries: readonly MarketplaceEntry[],
): ResolvedPluginSource | null {
  const entry = entries.find((e) => e.name === name);
  if (!entry) return null;
  const [owner, repo] = entry.source.repo.split("/", 2) as [string, string];
  return {
    owner,
    repo,
    path: entry.source.path ?? "",
    ref: entry.source.ref,
  };
}
