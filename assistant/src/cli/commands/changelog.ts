/**
 * `assistant changelog`
 *
 * Lazy, fetched-on-demand release-notes surface. Pulls release bodies from
 * the public GitHub Releases API for `vellum-ai/vellum-assistant` and caches
 * them locally so repeat invocations don't hit the network.
 *
 * Subcommands:
 *   - default action — show the latest stable release
 *   - `--since <version>` — concatenate every stable release newer than
 *     <version>, newest first
 *   - `show <version>` — show a single specific release tag
 *   - `list` — print the recent release tags and dates
 *
 * The CLI is intentionally a pure read-side surface; nothing is pushed to
 * the user at startup. A follow-up PR will add a tiny "doorbell" wake when
 * the running version's `release_id` advances.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Command } from "commander";

import { getWorkspaceDir } from "../../util/platform.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import {
  CACHE_STABLE_LIMIT,
  changelogHelp,
  DEFAULT_LIST_LIMIT,
  LIST_TTL_MS,
  REPO,
} from "./changelog.help.js";

// ── Types ────────────────────────────────────────────────────────────

/**
 * Subset of the GitHub Releases API payload we care about. Any field the
 * upstream API may add stays compatible because we read by name and ignore
 * the rest.
 */
interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

/**
 * Cache shape persisted under `<workspace>/data/changelog-cache.json`.
 *
 * - `recent` holds the most recent stable releases, capped at
 *   `CACHE_STABLE_LIMIT`. TTL-gated via `fetchedAt`.
 * - `byTag` is a content-addressed slot for single-tag lookups. Release
 *   tags are immutable once published, so entries here are kept without a
 *   TTL — first `show <tag>` populates, subsequent calls short-circuit
 *   the fetch.
 */
interface CacheStore {
  fetchedAt: string;
  recent: GitHubRelease[];
  byTag: Record<string, GitHubRelease>;
}

// ── Config ───────────────────────────────────────────────────────────

const MAX_LIST_LIMIT = 100;
/**
 * When fetching, request a page size that comfortably covers the caller's
 * requested limit plus a small buffer to absorb the occasional draft or
 * pre-release without forcing a second round-trip.
 */
const STABLE_BUFFER = 5;
const MIN_FETCH_PAGE_SIZE = 30;
const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = "vellum-assistant-cli";

// ── Cache plumbing ───────────────────────────────────────────────────

function getCachePath(): string {
  return join(getWorkspaceDir(), "data", "changelog-cache.json");
}

function readCache(): CacheStore | null {
  try {
    const path = getCachePath();
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as Partial<CacheStore>;
    if (
      typeof parsed.fetchedAt !== "string" ||
      !Array.isArray(parsed.recent) ||
      typeof parsed.byTag !== "object" ||
      parsed.byTag === null
    ) {
      return null;
    }
    return parsed as CacheStore;
  } catch {
    return null;
  }
}

function writeCache(store: CacheStore): void {
  try {
    const path = getCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2));
  } catch (err) {
    // Cache is best-effort; never fail the command because of a write error.
    log.warn(`Failed to write changelog cache: ${(err as Error).message}`);
  }
}

function isStale(cache: CacheStore): boolean {
  const fetchedAt = Date.parse(cache.fetchedAt);
  if (Number.isNaN(fetchedAt)) return true;
  return Date.now() - fetchedAt > LIST_TTL_MS;
}

// ── Network ──────────────────────────────────────────────────────────

async function githubFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

function describeGithubError(status: number, body: string): string {
  if (status === 403 || status === 429) {
    return "GitHub API rate limit reached. Wait a few minutes and retry, or pass --no-cache after the limit resets.";
  }
  if (status === 404) {
    return "Release not found on GitHub.";
  }
  return `GitHub API error ${status}: ${body || "(no body)"}`;
}

/**
 * Compute the per-page size for a fetch that needs to cover `limit` stable
 * releases. The buffer absorbs drafts/prereleases without paginating; we cap
 * at `MAX_LIST_LIMIT` because that's GitHub's per-page maximum.
 */
function pageSizeFor(limit: number): number {
  return Math.min(
    MAX_LIST_LIMIT,
    Math.max(limit + STABLE_BUFFER, MIN_FETCH_PAGE_SIZE),
  );
}

async function fetchReleaseList(limit: number): Promise<GitHubRelease[]> {
  const url = `https://api.github.com/repos/${REPO}/releases?per_page=${pageSizeFor(limit)}`;
  const res = await githubFetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(describeGithubError(res.status, text));
  }
  return (await res.json()) as GitHubRelease[];
}

async function fetchReleaseByTag(tag: string): Promise<GitHubRelease | null> {
  const url = `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await githubFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(describeGithubError(res.status, text));
  }
  return (await res.json()) as GitHubRelease;
}

// ── Cache-aware loaders ──────────────────────────────────────────────

interface LoadOpts {
  noCache: boolean;
  limit: number;
}

/**
 * Persist the rolling list of stable releases. Cap at `CACHE_STABLE_LIMIT`.
 * Mirror each entry into `byTag` so single-tag lookups short-circuit fetches
 * for any tag that appears in the rolling list. Preserves any existing
 * tag-keyed entries (which never expire).
 */
function persistRecent(stable: GitHubRelease[]): void {
  const previous = readCache();
  const recent = stable.slice(0, CACHE_STABLE_LIMIT);
  const byTag: Record<string, GitHubRelease> = { ...(previous?.byTag ?? {}) };
  for (const r of recent) {
    byTag[r.tag_name] = r;
  }
  writeCache({ fetchedAt: new Date().toISOString(), recent, byTag });
}

/**
 * Persist a single tag fetched via `show <tag>`. Tags are immutable; this
 * entry survives subsequent list refreshes.
 */
function persistByTag(release: GitHubRelease): void {
  const previous = readCache();
  writeCache({
    fetchedAt: previous?.fetchedAt ?? new Date().toISOString(),
    recent: previous?.recent ?? [],
    byTag: { ...(previous?.byTag ?? {}), [release.tag_name]: release },
  });
}

/**
 * Returns up to `opts.limit` stable releases, newest first. Uses the cached
 * rolling list when fresh and large enough; otherwise fetches a single page
 * sized via `pageSizeFor` and filters stable. The cached rolling list is
 * capped at `CACHE_STABLE_LIMIT` even if the caller asks for more.
 */
async function loadReleases(opts: LoadOpts): Promise<GitHubRelease[]> {
  if (!opts.noCache) {
    const cache = readCache();
    if (cache && !isStale(cache) && cache.recent.length >= opts.limit) {
      return cache.recent.slice(0, opts.limit);
    }
  }
  const raw = await fetchReleaseList(opts.limit);
  const stable = stableReleases(raw);
  persistRecent(stable);
  return stable.slice(0, opts.limit);
}

/**
 * Returns the release for a specific tag. Prefers the cached `byTag` slot
 * (immutable, no TTL), then the rolling recent list, then the network.
 * Persists fetched results into `byTag` so subsequent lookups short-circuit.
 */
async function loadReleaseByTag(
  tag: string,
  opts: { noCache: boolean },
): Promise<GitHubRelease | null> {
  if (!opts.noCache) {
    const cache = readCache();
    const hit =
      cache?.byTag[tag] ?? cache?.recent.find((r) => r.tag_name === tag);
    if (hit) return hit;
  }
  const release = await fetchReleaseByTag(tag);
  if (release) persistByTag(release);
  return release;
}

// ── Filtering / version utilities ────────────────────────────────────

/** Drop drafts and pre-releases; release notes only show shipped versions. */
function stableReleases(releases: GitHubRelease[]): GitHubRelease[] {
  return releases.filter((r) => !r.draft && !r.prerelease);
}

/** Accept `0.8.0` or `v0.8.0` from the user; canonicalize to the tag form. */
function normalizeTag(input: string): string {
  return input.startsWith("v") ? input : `v${input}`;
}

/**
 * Lightweight semver compare. Only handles `vMAJOR.MINOR.PATCH` (the format
 * the release pipeline emits in `.github/workflows/release.yml`). Prerelease
 * suffixes are ignored because we filter prereleases out before comparing.
 */
function compareTags(a: string, b: string): number {
  const parse = (tag: string): number[] =>
    tag
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .map((n) => (Number.isNaN(n) ? 0 : n));
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ── Rendering ────────────────────────────────────────────────────────

function renderRelease(r: GitHubRelease): string {
  const heading = r.name && r.name.trim().length > 0 ? r.name : r.tag_name;
  const date = r.published_at ? r.published_at.slice(0, 10) : "";
  const lines = [`# ${heading}`];
  if (date) lines.push(`Published: ${date}`);
  if (r.html_url) lines.push(r.html_url);
  lines.push("");
  if (r.body && r.body.trim().length > 0) lines.push(r.body.trim());
  else lines.push("(no release body)");
  return lines.join("\n");
}

function renderList(releases: GitHubRelease[]): string {
  if (releases.length === 0) return "No releases found.";
  const tagWidth = Math.max(...releases.map((r) => r.tag_name.length), 6);
  return releases
    .map((r) => {
      const date = r.published_at ? r.published_at.slice(0, 10) : "          ";
      const name = r.name && r.name.trim().length > 0 ? r.name : r.tag_name;
      return `${r.tag_name.padEnd(tagWidth)}  ${date}  ${name}`;
    })
    .join("\n");
}

// ── Action helpers ───────────────────────────────────────────────────

function parseLimit(input: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(input ?? ""), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_LIST_LIMIT);
}

function emit(output: string): void {
  process.stdout.write(output.endsWith("\n") ? output : output + "\n");
}

function emitError(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

interface CommonOpts {
  cache?: boolean;
  json?: boolean;
  limit?: string;
}

interface DefaultOpts extends CommonOpts {
  since?: string;
}

async function runDefault(opts: DefaultOpts): Promise<void> {
  const noCache = opts.cache === false;
  const useJson = opts.json === true;

  if (opts.since) {
    // --since needs the full rolling list so we can filter by tag.
    const limit = parseLimit(opts.limit, DEFAULT_LIST_LIMIT);
    const floor = normalizeTag(opts.since);
    const all = await loadReleases({ noCache, limit });
    const newer = all
      .filter((r) => compareTags(r.tag_name, floor) > 0)
      .sort((a, b) => compareTags(b.tag_name, a.tag_name));
    if (newer.length === 0) {
      if (useJson) emit(JSON.stringify({ releases: [] }));
      else log.info(`No releases newer than ${floor}.`);
      return;
    }
    if (useJson) {
      emit(JSON.stringify({ releases: newer }, null, 2));
    } else {
      emit(newer.map(renderRelease).join("\n\n---\n\n"));
    }
    return;
  }

  // Bare default action only needs the latest stable release. Asking for 1
  // means a populated cache (even with a single entry) is enough to short-
  // circuit the network round-trip.
  const releases = await loadReleases({ noCache, limit: 1 });
  if (releases.length === 0) {
    emitError("No releases found.");
  }
  const latest = releases[0];
  if (useJson) emit(JSON.stringify(latest, null, 2));
  else emit(renderRelease(latest));
}

async function runShow(version: string, opts: CommonOpts): Promise<void> {
  const noCache = opts.cache === false;
  const useJson = opts.json === true;
  const tag = normalizeTag(version);
  const release = await loadReleaseByTag(tag, { noCache });
  if (!release) {
    emitError(`No release found for tag ${tag}.`);
  }
  if (useJson) emit(JSON.stringify(release, null, 2));
  else emit(renderRelease(release));
}

async function runList(opts: CommonOpts): Promise<void> {
  const noCache = opts.cache === false;
  const useJson = opts.json === true;
  const limit = parseLimit(opts.limit, DEFAULT_LIST_LIMIT);
  const releases = await loadReleases({ noCache, limit });
  if (useJson) {
    emit(JSON.stringify({ releases }, null, 2));
    return;
  }
  emit(renderList(releases));
}

async function withErrorHandling(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    emitError((err as Error).message);
  }
}

// ── Registration ─────────────────────────────────────────────────────

export function registerChangelogCommand(program: Command): void {
  registerCommand(program, {
    name: changelogHelp.name,
    transport: "local",
    description: changelogHelp.description,
    build: (cmd) => {
      // Shared flags live on the parent (declared in the help data) so
      // they're inherited by subcommands via `command.optsWithGlobals()`.
      // Declaring the same flag on both parent and subcommand confuses
      // commander's option resolution — the parent wins and the
      // subcommand's copy never gets populated.
      applyCommandHelp(cmd, changelogHelp);

      cmd.action(async (opts: DefaultOpts) => {
        await withErrorHandling(() => runDefault(opts));
      });

      subcommand(cmd, "show").action(
        async (version: string, _opts, command: Command) => {
          const merged = command.optsWithGlobals() as CommonOpts;
          await withErrorHandling(() => runShow(version, merged));
        },
      );

      subcommand(cmd, "list").action(async (_opts, command: Command) => {
        const merged = command.optsWithGlobals() as CommonOpts;
        await withErrorHandling(() => runList(merged));
      });
    },
  });
}
