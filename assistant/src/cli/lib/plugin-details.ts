/**
 * Resolve a single plugin's detail view: tracked metadata plus its README.
 *
 * Powers the daemon's `GET /v1/plugins/:name` route and, through it, the web
 * plugin detail page. The detail view unions three sources, preferring the
 * most authoritative for each field:
 *   1. The locally installed copy under `<workspacePluginsDir>/<name>/`, when
 *      present — its `package.json` and `README.md` are read straight off disk.
 *   2. The gated plugin catalog (platform-first, bundled offline) — the same
 *      source `assistant plugins search` and install-by-name resolve — for
 *      external ecosystem plugins (description / homepage / license / pinned
 *      source).
 *   3. The plugin's own external repository at the pinned `owner/repo[/path]`,
 *      fetched via the GitHub Contents API for the README and any
 *      `package.json` fields the manifest doesn't carry.
 *
 * The `source` field is the catalog entry's pinned origin when one claims the
 * name, otherwise `null` — an installed copy with no catalog entry has no
 * advertised origin. Name-collision precedence matches {@link ./search-plugins}
 * and {@link ./install-from-github}: a catalog entry owns its name, so the
 * detail page advertises the external source the catalog and installer use. A
 * same-named `plugins/<name>/` directory is that plugin's adapter stub, not a
 * standalone plugin, so it does not override the claim.
 *
 * Designed for direct programmatic use with an injected `fetch`, mirroring the
 * sibling plugin libraries.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getWorkspacePluginsDir } from "../../util/platform.js";
import type { FetchLike } from "./fetch-like.js";
import { sanitizePluginName } from "./install-from-github.js";
import {
  parsePluginArtifact,
  parsePluginIcon,
  type PluginArtifact,
} from "./plugin-artifact.js";
import { findCatalogEntry } from "./plugin-catalog-resolve.js";
import { DEFAULT_PLUGIN_REF } from "./plugin-constants.js";
import { readValidatedPluginIcon } from "./plugin-icon-file.js";
import type {
  PluginMatchSource,
  PluginSearchMatch,
} from "./search-plugins.js";

/** Recognised README filenames, matched case-insensitively against a listing. */
const README_RE = /^readme(\.md|\.markdown)?$/i;

/** Entry shape returned by the GitHub Contents API for a directory listing. */
interface GitHubContentEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "dir" | "symlink" | "submodule";
  readonly download_url: string | null;
}

/** The subset of `package.json` fields the detail view surfaces. */
interface PluginManifestFields {
  readonly version: string | null;
  readonly description: string | null;
  readonly homepage: string | null;
  readonly license: string | null;
  readonly artifact: PluginArtifact | null;
  readonly icon: string | null;
}

/** Options that control which plugin to resolve and at what ref. */
export interface PluginDetailsOptions {
  /** Install name (kebab-case directory name). */
  readonly name: string;
  /** Git ref to read catalog metadata / README from. Defaults to {@link DEFAULT_PLUGIN_REF}. */
  readonly ref?: string;
}

/** Dependencies injected by the caller. */
export interface PluginDetailsDeps {
  /** HTTP client. Production callers pass `globalThis.fetch.bind(globalThis)`. */
  readonly fetch: FetchLike;
  /** Override the workspace plugins directory. Falls back to {@link getWorkspacePluginsDir}. */
  readonly workspacePluginsDir?: string;
}

/** Resolved detail view for a single plugin. */
export interface PluginDetails {
  /** Install name. Matches `assistant plugins install <name>`. */
  readonly name: string;
  /** Whether a copy is materialized under the workspace plugins directory. */
  readonly installed: boolean;
  /** Short description, best-effort across the three sources; `null` when unknown. */
  readonly description: string | null;
  /** Project homepage URL, when known; `null` otherwise. */
  readonly homepage: string | null;
  /** SPDX license expression, when known; `null` otherwise. */
  readonly license: string | null;
  /** Resolved version (installed copy first, then repo `package.json`); `null` when unknown. */
  readonly version: string | null;
  /**
   * Pinned origin, mirroring the catalog's {@link PluginMatchSource}; `null`
   * when an installed copy has no catalog entry to advertise an origin.
   */
  readonly source: PluginMatchSource | null;
  /** README markdown, or `null` when the plugin ships none. */
  readonly readme: string | null;
  /** Git ref the catalog metadata / README were resolved at. */
  readonly ref: string;
  /**
   * Prebuilt client artifact (download URL + sha256) declared in the
   * plugin's `package.json` `vellum.artifact`, resolved from the installed
   * copy first then the repo; `null` when the plugin ships none or its
   * descriptor is incomplete (e.g. a placeholder `sha256`).
   */
  readonly artifact: PluginArtifact | null;
  /**
   * Author-declared emoji icon from the plugin's `package.json` `vellum.icon`,
   * resolved from the installed copy first then the repo; `null` when none.
   */
  readonly icon: string | null;
  /**
   * Whether the locally installed copy ships a valid author-bundled `icon.png`
   * (validated for PNG magic, dimensions, and size). `false` when the plugin is
   * not installed or ships no valid icon.
   */
  readonly hasIcon: boolean;
  /**
   * Content hash of the validated `icon.png`; `null` when {@link hasIcon} is
   * false. A cache-buster for the bundled-icon endpoint.
   */
  readonly iconVersion: string | null;
}

/** No installed copy and no catalog/source entry claims the name. */
export class PluginDetailsNotFoundError extends Error {
  constructor(
    readonly pluginName: string,
    readonly ref: string,
  ) {
    super(`Plugin "${pluginName}" not found in the catalog (ref ${ref}).`);
    this.name = "PluginDetailsNotFoundError";
  }
}

/**
 * Resolve the detail view for {@link opts.name}.
 *
 * Throws {@link PluginDetailsNotFoundError} when the name is neither installed
 * locally nor present in the gated plugin catalog. A catalog outage or network
 * failures while enriching from GitHub degrade to the fields already known from
 * disk / the catalog rather than failing the whole view — a detail page that
 * renders metadata without a README beats a hard error.
 */
export async function getPluginDetails(
  opts: PluginDetailsOptions,
  deps: PluginDetailsDeps,
): Promise<PluginDetails> {
  const name = sanitizePluginName(opts.name);
  const ref = opts.ref ?? DEFAULT_PLUGIN_REF;
  const { fetch: fetchFn } = deps;

  const pluginsDir = deps.workspacePluginsDir ?? getWorkspacePluginsDir();
  const local = readLocalPlugin(pluginsDir, name);
  // Validate the installed copy's bundled icon.png (fail-closed: a missing or
  // invalid icon — including a not-installed plugin — resolves to no icon).
  const localIcon = readValidatedPluginIcon(join(pluginsDir, name));

  const catalogMatch = await findCatalogMatch(name, fetchFn);

  if (!local.installed && !catalogMatch) {
    throw new PluginDetailsNotFoundError(name, ref);
  }

  const source: PluginMatchSource | null = catalogMatch?.source ?? null;

  const remote = source
    ? await readRemotePlugin(source, fetchFn)
    : { manifest: emptyManifest(), readme: null };

  const readme = local.readme ?? remote.readme;

  return {
    name,
    installed: local.installed,
    description:
      local.manifest.description ??
      catalogMatch?.description ??
      remote.manifest.description ??
      null,
    homepage:
      local.manifest.homepage ??
      catalogMatch?.homepage ??
      remote.manifest.homepage ??
      null,
    license:
      local.manifest.license ??
      catalogMatch?.license ??
      remote.manifest.license ??
      null,
    version: local.manifest.version ?? remote.manifest.version ?? null,
    source,
    readme,
    ref,
    artifact: local.manifest.artifact ?? remote.manifest.artifact,
    icon: local.manifest.icon ?? remote.manifest.icon,
    hasIcon: localIcon.hasIcon,
    iconVersion: localIcon.iconVersion ?? null,
  };
}

interface LocalPlugin {
  readonly installed: boolean;
  readonly manifest: PluginManifestFields;
  readonly readme: string | null;
}

/** Read an installed copy's `package.json` + README off disk, if present. */
function readLocalPlugin(pluginsDir: string, name: string): LocalPlugin {
  const target = join(pluginsDir, name);
  if (!existsSync(target)) {
    return { installed: false, manifest: emptyManifest(), readme: null };
  }

  const pkgPath = join(target, "package.json");
  let manifest = emptyManifest();
  if (existsSync(pkgPath)) {
    try {
      manifest = parseManifest(readFileSync(pkgPath, "utf8"));
    } catch {
      // A malformed local manifest degrades to empty fields — the entry is
      // still "installed", we just have nothing extra to surface from it.
    }
  }

  return { installed: true, manifest, readme: readLocalReadme(target) };
}

/** Find a README file in a directory listing and read it, if any. */
function readLocalReadme(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const readme = names.find((n) => README_RE.test(n));
  if (!readme) {
    return null;
  }
  try {
    return readFileSync(join(dir, readme), "utf8");
  } catch {
    return null;
  }
}

interface RemotePlugin {
  readonly manifest: PluginManifestFields;
  readonly readme: string | null;
}

/**
 * Fetch README + `package.json` from the plugin's external repository.
 *
 * Lists the plugin's `owner/repo[/path]` directory fresh at its own pinned
 * `source.ref` — the detail page must describe the same artifact the installer
 * resolves from `source.ref`, even when that differs from the catalog ref
 * (`main`).
 */
async function readRemotePlugin(
  source: PluginMatchSource,
  fetchFn: FetchLike,
): Promise<RemotePlugin> {
  const [owner, repo] = source.repo.split("/", 2) as [string, string];
  const entries = await listDirSafe(
    owner,
    repo,
    source.path ?? "",
    source.ref,
    fetchFn,
  );

  if (!entries) {
    return { manifest: emptyManifest(), readme: null };
  }

  const readmeEntry = entries.find(
    (e) => e.type === "file" && README_RE.test(e.name),
  );
  const pkgEntry = entries.find(
    (e) => e.type === "file" && e.name === "package.json",
  );

  const [readme, manifest] = await Promise.all([
    readmeEntry ? fetchRawFile(readmeEntry, fetchFn) : Promise.resolve(null),
    pkgEntry
      ? fetchRawFile(pkgEntry, fetchFn).then((raw) =>
          raw ? safeParseManifest(raw) : emptyManifest(),
        )
      : Promise.resolve(emptyManifest()),
  ]);

  return { manifest, readme };
}

/** List a repo directory, returning `null` on 404 or any transient failure. */
async function listDirSafe(
  owner: string,
  repo: string,
  apiPath: string,
  ref: string,
  fetchFn: FetchLike,
): Promise<readonly GitHubContentEntry[] | null> {
  const suffix = apiPath
    ? `/${encodeURIComponent(apiPath).replaceAll("%2F", "/")}`
    : "";
  const url =
    `https://api.github.com/repos/${owner}/${repo}/contents${suffix}` +
    `?ref=${encodeURIComponent(ref)}`;

  try {
    const res = await githubFetch(url, "application/vnd.github+json", fetchFn);
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) {
      return null;
    }
    return body as readonly GitHubContentEntry[];
  } catch {
    return null;
  }
}

/** Download a file entry's raw body, returning `null` on any failure. */
async function fetchRawFile(
  entry: GitHubContentEntry,
  fetchFn: FetchLike,
): Promise<string | null> {
  if (!entry.download_url) {
    return null;
  }
  try {
    const res = await githubFetch(
      entry.download_url,
      "application/vnd.github.raw",
      fetchFn,
    );
    if (!res.ok) {
      return null;
    }
    return await res.text();
  } catch {
    return null;
  }
}

async function findCatalogMatch(
  name: string,
  fetchFn: FetchLike,
): Promise<PluginSearchMatch | null> {
  try {
    return await findCatalogEntry(name, { fetch: fetchFn });
  } catch {
    // A catalog outage (fail-hard `PluginCatalogUnavailableError`) or malformed
    // entry degrades to "no catalog entry" — the catalog metadata is
    // supplementary, never required to render a detail view.
    return null;
  }
}

function githubFetch(
  url: string,
  accept: string,
  fetchFn: FetchLike,
): Promise<Response> {
  return fetchFn(url, {
    headers: { Accept: accept, "User-Agent": "vellum-assistant-cli" },
  });
}

function emptyManifest(): PluginManifestFields {
  return {
    version: null,
    description: null,
    homepage: null,
    license: null,
    artifact: null,
    icon: null,
  };
}

function safeParseManifest(raw: string): PluginManifestFields {
  try {
    return parseManifest(raw);
  } catch {
    return emptyManifest();
  }
}

/** Extract the surfaced fields from a `package.json` body. Throws on bad JSON. */
function parseManifest(raw: string): PluginManifestFields {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return emptyManifest();
  }
  const meta = parsed as Record<string, unknown>;
  return {
    version: typeof meta.version === "string" ? meta.version : null,
    description: typeof meta.description === "string" ? meta.description : null,
    homepage: typeof meta.homepage === "string" ? meta.homepage : null,
    license: normalizeLicense(meta.license),
    artifact: parsePluginArtifact(parsed),
    icon: parsePluginIcon(parsed) ?? null,
  };
}

/**
 * `package.json#license` is usually an SPDX string but the legacy object form
 * `{ "type": "MIT" }` still appears in the wild — surface its `type`.
 */
function normalizeLicense(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  ) {
    return (value as { type: string }).type;
  }
  return null;
}
