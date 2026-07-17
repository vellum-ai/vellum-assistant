/**
 * Install a plugin by name from the platform's public install endpoint.
 *
 * Plugin installs are platform-managed and content flows *through* the platform
 * (npm-style): the endpoint assembles a `.tgz` of the plugin's files from the
 * pinned commit, server-side, and serves it as `application/gzip`. The daemon
 * downloads that tarball, verifies its integrity against the `ETag` sha256,
 * and extracts it into the plugin's install directory — it does NOT clone the
 * plugin from GitHub itself, and it does NOT emit `plugin_installed` telemetry
 * (hitting this endpoint *is* the recorded install; the server rejects that
 * event type on the usual ingest path).
 *
 *     GET {PLATFORM_BASE_URL}/v1/plugins/{name}/install/
 *
 * The endpoint is public (works anonymously); when the daemon has an assistant
 * API key it is sent so the install is attributed to the real user/org.
 *
 * Designed for direct programmatic use with injected deps (mirroring
 * {@link ./install-from-github}). The CLI command `assistant plugins install
 * <name>` calls {@link installPluginViaPlatform}, which resolves production
 * deps (platform base URL, optional API key, attribution) and delegates to
 * {@link installPluginFromPlatform}.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import { getPlatformBaseUrl } from "../../config/env.js";
import { getExistingDeviceId } from "../../util/device-id.js";
import { getWorkspacePluginsDir } from "../../util/platform.js";
import { APP_VERSION } from "../../version.js";
import type { FetchLike } from "./fetch-like.js";
import {
  finalizeStagedInstall,
  type InstallPluginResult,
  PluginAlreadyInstalledError,
  type PluginFetchSource,
  PluginNotFoundError,
  PluginSourceUnavailableError,
  sanitizePluginName,
} from "./install-from-github.js";

/**
 * The downloaded artifact's sha256 did not match the `ETag` the endpoint
 * advertised. The archive is corrupt or tampered — the install is aborted
 * before extraction rather than materializing untrusted bytes.
 */
export class PluginIntegrityError extends Error {
  constructor(
    readonly pluginName: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Integrity check failed for "${pluginName}": expected sha256 ${expected}, ` +
        `got ${actual}. The download was corrupt or tampered — aborting.`,
    );
    this.name = "PluginIntegrityError";
  }
}

/**
 * A tar entry's path escaped the install directory (`..`, an absolute path, or
 * a separator-laden name), or the archive was otherwise malformed. Archive
 * paths are never trusted blindly, so such an entry aborts the whole extract.
 */
export class PluginArchiveError extends Error {
  constructor(
    readonly pluginName: string,
    detail: string,
  ) {
    super(`Archive for "${pluginName}" is invalid: ${detail}`);
    this.name = "PluginArchiveError";
  }
}

/** The plugin exceeds the platform's install size cap (HTTP 413). */
export class PluginTooLargeError extends Error {
  constructor(readonly pluginName: string) {
    super(
      `Plugin "${pluginName}" is too large to install (the platform enforces a size cap).`,
    );
    this.name = "PluginTooLargeError";
  }
}

/** The caller was rate limited (HTTP 429) and retries were exhausted. */
export class PluginRateLimitedError extends Error {
  constructor(readonly pluginName: string) {
    super(
      `Installing "${pluginName}" was rate limited. Wait a moment and try again.`,
    );
    this.name = "PluginRateLimitedError";
  }
}

/** Options controlling which plugin to install and how. */
export interface InstallFromPlatformOptions {
  readonly name: string;
  /** Overwrite an existing install in place. Preserved on disk until download+verify succeed. */
  readonly force?: boolean;
  /** Daemon device id, forwarded as `installation_id` for richer attribution. */
  readonly installationId?: string;
  /** Conversation id, forwarded as `conversation_id` when the install is assistant-driven. */
  readonly conversationId?: string;
  /** Assistant version, forwarded as `assistant_version`. */
  readonly assistantVersion?: string;
}

/** Dependencies injected by the caller. */
export interface InstallFromPlatformDeps {
  /** HTTP client. Production callers pass `globalThis.fetch.bind(globalThis)`. */
  readonly fetch: FetchLike;
  /** Platform base URL (no trailing slash required). */
  readonly platformBaseUrl: string;
  /** Assistant API key. When present the install is attributed to the real user/org. */
  readonly apiKey?: string;
  /** Override the workspace plugins directory. Falls back to {@link getWorkspacePluginsDir}. */
  readonly workspacePluginsDir?: string;
  /** Max attempts for a transient status (429 / 502). Defaults to {@link DEFAULT_MAX_ATTEMPTS}. */
  readonly maxAttempts?: number;
  /** Sleep between retries. Injected so tests don't wait real time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Total attempts (initial + retries) for a transient upstream status. */
const DEFAULT_MAX_ATTEMPTS = 4;

/** Base backoff between retries (doubles each attempt). */
const RETRY_BASE_MS = 500;

/** Metadata extracted from the install endpoint's response headers. */
interface InstallResponseMeta {
  /** `sha256:<64-hex>` integrity digest, or null when the header was absent/malformed. */
  readonly etag: string | null;
  /** Pinned commit SHA (`X-Plugin-Ref`); recorded as the installed version. */
  readonly ref: string | null;
  /** `owner/repo` (`X-Plugin-Repo`). */
  readonly repo: string | null;
  /** Repo-relative plugin root (`X-Plugin-Source-Path`), present only for monorepo/subdir plugins. */
  readonly sourcePath: string | null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Download, verify, and extract a plugin from the platform install endpoint.
 *
 * Staging mirrors {@link installPlugin}: the tree is extracted into a sibling
 * staging dir and only swapped into `<pluginsDir>/<name>` once the download,
 * integrity check, and extraction all succeed — so a transient failure leaves
 * a previously installed copy untouched even under `force`.
 */
export async function installPluginFromPlatform(
  opts: InstallFromPlatformOptions,
  deps: InstallFromPlatformDeps,
): Promise<InstallPluginResult> {
  const name = sanitizePluginName(opts.name);
  const force = opts.force ?? false;

  const pluginsDir = deps.workspacePluginsDir ?? getWorkspacePluginsDir();
  const target = join(pluginsDir, name);
  if (existsSync(target) && !force) {
    throw new PluginAlreadyInstalledError(name, target);
  }

  const { body, meta } = await downloadInstallArchive(name, opts, deps);

  // Verify integrity before touching disk. The ETag is the sha256 of the
  // response body — abort rather than extract a corrupt/tampered archive.
  verifyArchiveIntegrity(name, body, meta.etag);

  const stagingRoot = join(dirname(pluginsDir), ".plugins-staging");
  mkdirSync(stagingRoot, { recursive: true });
  const stagingDir = join(stagingRoot, `${name}.installing.${process.pid}`);
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  mkdirSync(stagingDir, { recursive: true });

  let fileCount: number;
  try {
    fileCount = extractPluginTarball(name, body, stagingDir);
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }

  if (fileCount === 0) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw new PluginNotFoundError(name, meta.ref ?? "", meta.repo ?? name);
  }

  // Record provenance for future update/version UX. The endpoint re-roots the
  // tarball to the plugin root, so the recorded ref is the pinned commit and
  // the ETag documents exactly which bytes were verified.
  const source = buildFetchSource(meta);
  const ref = meta.ref ?? "";
  finalizeStagedInstall(stagingDir, {
    name,
    source,
    ref,
    commit: meta.ref,
    committedAt: null,
    ...(meta.etag ? { etag: meta.etag } : {}),
    pluginsDir,
  });

  return { name, target, fileCount, ref, commit: meta.ref, committedAt: null };
}

/**
 * Resolve production deps and install `name` from the platform endpoint.
 *
 * The CLI command `assistant plugins install <name>` calls this. It resolves
 * the platform base URL the daemon already uses, sends the assistant API key
 * when one is configured (attributing the install to the real user/org, else
 * anonymous), and forwards best-effort attribution (`installation_id`,
 * `assistant_version`).
 */
export async function installPluginViaPlatform(
  opts: { name: string; force?: boolean; conversationId?: string },
  deps: { fetch: FetchLike },
): Promise<InstallPluginResult> {
  const platformBaseUrl = getPlatformBaseUrl();
  const apiKey = await resolveAssistantApiKey();
  const installationId = getExistingDeviceId() ?? undefined;

  return installPluginFromPlatform(
    {
      name: opts.name,
      force: opts.force,
      ...(installationId ? { installationId } : {}),
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      assistantVersion: APP_VERSION,
    },
    { fetch: deps.fetch, platformBaseUrl, ...(apiKey ? { apiKey } : {}) },
  );
}

/**
 * Best-effort resolution of the assistant API key through the authorized
 * platform client (the same credential path `plugins publish` uses); the
 * install proceeds anonymously when the daemon isn't connected to the platform.
 */
async function resolveAssistantApiKey(): Promise<string | undefined> {
  try {
    const { VellumPlatformClient } = await import("../../platform/client.js");
    const client = await VellumPlatformClient.create();
    return client?.assistantApiKey || undefined;
  } catch {
    return undefined;
  }
}

/**
 * GET the install endpoint, retrying transient statuses (429 / 502) with
 * exponential backoff, and return the archive bytes plus response metadata.
 */
async function downloadInstallArchive(
  name: string,
  opts: InstallFromPlatformOptions,
  deps: InstallFromPlatformDeps,
): Promise<{ body: Buffer; meta: InstallResponseMeta }> {
  const url = buildInstallUrl(deps.platformBaseUrl, name, opts);
  const headers: Record<string, string> = {
    // The platform (Django) 406s a specific `application/gzip` Accept, so ask
    // for anything and sniff the body ourselves (see extractPluginTarball).
    Accept: "*/*",
    "User-Agent": "vellum-assistant-cli",
  };
  if (deps.apiKey) {
    headers.Authorization = `Api-Key ${deps.apiKey}`;
  }

  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = deps.sleep ?? defaultSleep;

  let lastTransient: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await deps.fetch(url, { method: "GET", headers });

    if (res.ok) {
      const body = Buffer.from(await res.arrayBuffer());
      return { body, meta: readResponseMeta(res) };
    }

    // Unknown plugin — a hard, non-retryable not-found.
    if (res.status === 404) {
      throw new PluginNotFoundError(name, "", `plugin "${name}"`);
    }
    // Size cap — non-retryable.
    if (res.status === 413) {
      throw new PluginTooLargeError(name);
    }
    // Rate limited or upstream/assembly hiccup — retry with backoff.
    if (res.status === 429 || res.status === 502 || res.status >= 500) {
      lastTransient =
        res.status === 429
          ? new PluginRateLimitedError(name)
          : new PluginSourceUnavailableError(
              `Plugin install endpoint returned HTTP ${res.status} for "${name}".`,
              res.status,
            );
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs(res, attempt));
        continue;
      }
      throw lastTransient;
    }

    throw new PluginSourceUnavailableError(
      `Plugin install endpoint returned HTTP ${res.status} for "${name}".`,
      res.status,
    );
  }

  // Unreachable in practice (the loop always returns or throws), but keeps the
  // type checker happy and preserves the last transient error if it is hit.
  throw (
    lastTransient ??
    new PluginSourceUnavailableError(
      `Plugin install failed for "${name}".`,
      503,
    )
  );
}

/** Compute the backoff before the next retry, honoring `Retry-After` on a 429. */
function retryDelayMs(res: Response, attempt: number): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  return RETRY_BASE_MS * 2 ** (attempt - 1);
}

/** Build the install URL, appending optional attribution query params. */
function buildInstallUrl(
  platformBaseUrl: string,
  name: string,
  opts: InstallFromPlatformOptions,
): string {
  const base = platformBaseUrl.replace(/\/+$/, "");
  const url = new URL(
    `${base}/v1/plugins/${encodeURIComponent(name)}/install/`,
  );
  if (opts.installationId) {
    url.searchParams.set("installation_id", opts.installationId);
  }
  if (opts.conversationId) {
    url.searchParams.set("conversation_id", opts.conversationId);
  }
  if (opts.assistantVersion) {
    url.searchParams.set("assistant_version", opts.assistantVersion);
  }
  return url.toString();
}

/** Extract the metadata headers the tarball itself cannot carry. */
function readResponseMeta(res: Response): InstallResponseMeta {
  return {
    etag: res.headers.get("etag"),
    ref: res.headers.get("x-plugin-ref"),
    repo: res.headers.get("x-plugin-repo"),
    sourcePath: res.headers.get("x-plugin-source-path"),
  };
}

/** Map the response metadata onto the provenance {@link PluginFetchSource}. */
function buildFetchSource(meta: InstallResponseMeta): PluginFetchSource {
  const [owner = "", repo = ""] = (meta.repo ?? "").split("/");
  return {
    owner,
    repo,
    rootPath: meta.sourcePath ?? "",
    ref: meta.ref ?? "",
  };
}

/**
 * Parse `ETag: "sha256:<hex>"`, compute the sha256 of `body`, and throw
 * {@link PluginIntegrityError} on mismatch. A missing/malformed ETag can't be
 * verified against, so verification is skipped in that case (the endpoint
 * always sends one for a real artifact).
 */
export function verifyArchiveIntegrity(
  name: string,
  body: Buffer,
  etag: string | null,
): void {
  const expected = parseSha256Etag(etag);
  if (!expected) {
    return;
  }
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new PluginIntegrityError(name, expected, actual);
  }
}

/** Strip the surrounding quotes and `sha256:` prefix from an ETag; null if absent/malformed. */
function parseSha256Etag(etag: string | null): string | null {
  if (!etag) {
    return null;
  }
  const unquoted = etag.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const match = /^sha256:([0-9a-f]{64})$/i.exec(unquoted);
  return match ? match[1]! : null;
}

// ─── Tar extraction ──────────────────────────────────────────────────────────

/** A regular-file entry recovered from the tar stream. */
interface TarFileEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** gzip streams begin with the magic bytes `0x1f 0x8b`. */
function isGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/**
 * Extract a plugin archive into `destDir`, returning the number of regular
 * files written. The archive is gunzipped when it carries the gzip magic bytes
 * and treated as a plain (uncompressed) POSIX tar otherwise — the platform
 * advertises `application/gzip` but may serve either, so the body is sniffed
 * rather than trusted by content-type. Entries are already plugin-root-relative
 * (the endpoint re-roots the tarball), so they are extracted as-is — but archive
 * paths are never trusted: any entry that resolves outside `destDir` aborts the
 * extract with {@link PluginArchiveError}.
 */
export function extractPluginTarball(
  name: string,
  archive: Buffer,
  destDir: string,
): number {
  let tar: Buffer;
  if (isGzip(archive)) {
    try {
      tar = gunzipSync(archive);
    } catch (err) {
      throw new PluginArchiveError(
        name,
        `not a valid gzip stream (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  } else {
    tar = archive;
  }

  const resolvedRoot = resolve(destDir);
  let count = 0;
  for (const entry of parseTarEntries(name, tar)) {
    const destPath = resolveSafeEntryPath(name, resolvedRoot, entry.name);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, entry.data);
    count++;
  }
  return count;
}

/**
 * Resolve `entryName` under `resolvedRoot`, rejecting absolute paths and any
 * name that escapes the root via `..`. Returns the absolute destination path.
 */
function resolveSafeEntryPath(
  pluginName: string,
  resolvedRoot: string,
  entryName: string,
): string {
  const normalized = entryName.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").some((seg) => seg === "..")
  ) {
    throw new PluginArchiveError(
      pluginName,
      `entry ${JSON.stringify(entryName)} escapes the install directory`,
    );
  }
  const destPath = resolve(resolvedRoot, normalized);
  if (destPath !== resolvedRoot && !destPath.startsWith(resolvedRoot + sep)) {
    throw new PluginArchiveError(
      pluginName,
      `entry ${JSON.stringify(entryName)} escapes the install directory`,
    );
  }
  return destPath;
}

/**
 * Walk a (decompressed) tar stream and yield its regular-file entries.
 *
 * Handles the ustar `prefix` field and the two long-name conventions a
 * server-side `git archive` / `tar` can emit — GNU `L` long-name records and
 * pax `x` extended headers carrying a `path=` record — so deeply nested plugin
 * paths (skills/…, tools/…) round-trip intact. Directories, symlinks, and
 * hardlinks are skipped (the loader follows neither); global pax headers are
 * ignored.
 */
function parseTarEntries(pluginName: string, tar: Buffer): TarFileEntry[] {
  const entries: TarFileEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    // End-of-archive: a zero block.
    if (header.every((b) => b === 0)) {
      break;
    }

    const size = parseTarSize(pluginName, header);
    const typeFlag = header[156];
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new PluginArchiveError(pluginName, "truncated tar entry");
    }
    const data = tar.subarray(dataStart, dataEnd);
    // Advance past this entry's data (padded to a 512-byte boundary).
    offset = dataStart + Math.ceil(size / 512) * 512;

    // GNU long name ('L'): the data block holds the name of the NEXT entry.
    if (typeFlag === 76 /* 'L' */) {
      longName = readCString(data);
      continue;
    }
    // pax extended header ('x'): may carry a `path=` override for the NEXT entry.
    if (typeFlag === 120 /* 'x' */) {
      paxPath = readPaxPath(data);
      continue;
    }
    // Global pax header ('g'): applies to the whole archive; ignored here.
    if (typeFlag === 103 /* 'g' */) {
      continue;
    }

    const name = paxPath ?? longName ?? readHeaderName(header);
    longName = null;
    paxPath = null;

    // Regular file: type '0' or the historical NUL. Everything else
    // (directory '5', symlink '2', hardlink '1', ...) is skipped.
    const isRegularFile = typeFlag === 0 || typeFlag === 48; /* '0' */
    if (isRegularFile && name && !name.endsWith("/")) {
      entries.push({ name, data: Buffer.from(data) });
    }
  }
  return entries;
}

/** Read the ustar name, prepending the `prefix` field when present. */
function readHeaderName(header: Buffer): string {
  const name = readCString(header.subarray(0, 100));
  const prefix = readCString(header.subarray(345, 500));
  return prefix ? `${prefix}/${name}` : name;
}

/** Parse the octal `size` field (bytes 124–136). */
function parseTarSize(pluginName: string, header: Buffer): number {
  const raw = header
    .subarray(124, 136)
    .toString("utf-8")
    .replace(/\0/g, "")
    .trim();
  const size = raw ? Number.parseInt(raw, 8) : 0;
  if (!Number.isFinite(size) || size < 0) {
    throw new PluginArchiveError(pluginName, "malformed tar size field");
  }
  return size;
}

/** Decode a NUL-terminated field to a UTF-8 string. */
function readCString(buf: Buffer): string {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString("utf-8");
}

/**
 * Extract the `path=` value from a pax extended header block. Each record is
 * `"<len> <key>=<value>\n"`; the `path` record overrides the entry name.
 */
function readPaxPath(data: Buffer): string | null {
  const text = data.toString("utf-8");
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space === -1) {
      break;
    }
    const len = Number.parseInt(text.slice(i, space), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > text.length) {
      break;
    }
    const record = text.slice(space + 1, i + len - 1); // drop trailing '\n'
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path") {
      return record.slice(eq + 1);
    }
    i += len;
  }
  return null;
}
