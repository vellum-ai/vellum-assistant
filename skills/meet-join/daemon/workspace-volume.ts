/**
 * Workspace volume discovery — figures out which Docker named volume backs
 * the assistant's `/workspace` mount when the daemon runs inside a container.
 *
 * Meet-bot containers need to mount the same workspace volume as the
 * assistant so transcripts, audio, and other meeting artifacts land on the
 * shared per-instance volume (see `docs` under Docker Volume Architecture).
 * To launch a sibling container with a matching bind/volume spec, we first
 * have to know the volume's name — which the running process can only
 * discover by inspecting its own mount table.
 *
 * The Linux kernel exposes mount information at `/proc/self/mountinfo`.
 * Each line is space-separated:
 *
 *   mount_id parent_id major:minor root mount_point mount_options ... - fs_type mount_source super_options
 *
 * Docker binds named volumes under
 * `/var/lib/docker/volumes/<volname>/_data` on the host, so when a container
 * mounts one at `/workspace` the `mount_source` field (first field after the
 * `-` separator) carries that path. Parsing it gives us the volume name
 * without needing to shell out to `docker inspect` or touch the Docker API.
 *
 * On non-Linux hosts (macOS/Windows developer machines running the daemon
 * bare-metal) `/proc/self/mountinfo` does not exist — we return `null`
 * cleanly. Callers should treat `null` as "daemon not in a Docker
 * workspace mount"; Meet's Docker runner will use this result to either
 * reuse the discovered volume or fall back to a host bind mount for
 * local-mode launches.
 *
 * This helper is unused by default; PR 3 in the Meet Docker-mode plan wires
 * it into the session-manager's container launch path.
 */

import { readFile } from "node:fs/promises";

import { getLogger } from "../../../assistant/src/util/logger.js";

const log = getLogger("meet-workspace-volume");

/** Default path to the Linux mount-info virtual file. */
const DEFAULT_MOUNTINFO_PATH = "/proc/self/mountinfo";

/** Container-internal path the workspace volume is mounted at. */
const WORKSPACE_MOUNT_POINT = "/workspace";

/**
 * Env-var fallback. The CLI can set this when spawning the daemon container
 * as a belt-and-suspenders hint — useful if mountinfo parsing breaks on
 * some future Docker layout, or when the runtime uses a less common
 * storage driver.
 */
const VOLUME_NAME_ENV_VAR = "VELLUM_WORKSPACE_VOLUME_NAME";

/**
 * Regex that extracts `<volname>` from a Docker volume source path like
 * `/var/lib/docker/volumes/<volname>/_data`. The volume name may contain
 * letters, digits, dashes, underscores, and dots per Docker's allowed
 * charset.
 */
const DOCKER_VOLUME_SOURCE_RE =
  /^\/var\/lib\/docker\/volumes\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/_data$/;

/**
 * Options for {@link getWorkspaceVolumeName}. Primarily for test injection.
 */
export interface GetWorkspaceVolumeNameOptions {
  /** Override the mountinfo path. Defaults to `/proc/self/mountinfo`. */
  mountinfoPath?: string;
  /**
   * Override the environment object used for the fallback lookup. Defaults
   * to `process.env`. Tests pass a fresh object so the real environment
   * doesn't leak in.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Module-level cache. Holds the in-flight or resolved promise from the
 * first successful (or failed) lookup with default options so concurrent
 * callers share a single parse pass. Tests that pass overrides bypass the
 * cache — this keeps fixtures from poisoning production reads and vice
 * versa.
 */
let cachedPromise: Promise<string | null> | null = null;

/**
 * Resolve the name of the Docker named volume backing `/workspace`, or
 * `null` if we can't determine one (daemon is bare-metal, workspace is a
 * host bind mount, or the file couldn't be read).
 *
 * Result is cached on the first call that uses default options; subsequent
 * calls without overrides return the cached value immediately. The value
 * doesn't change for the lifetime of the process — the mount table is
 * established at container start.
 */
export function getWorkspaceVolumeName(
  options: GetWorkspaceVolumeNameOptions = {},
): Promise<string | null> {
  const hasOverrides =
    options.mountinfoPath !== undefined || options.env !== undefined;
  if (hasOverrides) {
    // Bypass cache for test injection so fixtures can't contaminate real
    // lookups and vice versa.
    return resolveWorkspaceVolumeName(options);
  }
  if (cachedPromise === null) {
    cachedPromise = resolveWorkspaceVolumeName(options);
  }
  return cachedPromise;
}

/**
 * Reset the memoized lookup. Only for tests that want to re-exercise the
 * cache path; production code should never call this.
 */
export function resetWorkspaceVolumeNameCacheForTests(): void {
  cachedPromise = null;
}

async function resolveWorkspaceVolumeName(
  options: GetWorkspaceVolumeNameOptions,
): Promise<string | null> {
  const mountinfoPath = options.mountinfoPath ?? DEFAULT_MOUNTINFO_PATH;
  const env = options.env ?? process.env;

  const fromMountinfo = await readMountinfoVolumeName(mountinfoPath);
  if (fromMountinfo !== null) {
    return fromMountinfo;
  }

  const fromEnv = env[VOLUME_NAME_ENV_VAR];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }

  return null;
}

async function readMountinfoVolumeName(
  mountinfoPath: string,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(mountinfoPath, "utf8");
  } catch (err) {
    // Expected on macOS/Windows — `/proc` doesn't exist. Log at debug so
    // we don't spam warnings on every developer machine.
    log.debug(
      { err, mountinfoPath },
      "Failed to read mountinfo; workspace volume discovery will fall back",
    );
    return null;
  }

  return parseWorkspaceVolumeFromMountinfo(raw);
}

/**
 * Parse a raw mountinfo blob and return the Docker volume name backing
 * `/workspace`, or `null` if no matching entry is present.
 *
 * Exported for direct unit testing with synthetic fixtures.
 */
export function parseWorkspaceVolumeFromMountinfo(
  raw: string,
): string | null {
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const volumeName = extractVolumeNameFromLine(line);
    if (volumeName !== null) return volumeName;
  }
  return null;
}

function extractVolumeNameFromLine(line: string): string | null {
  // mountinfo format:
  //   mount_id parent_id major:minor root mount_point mount_options (optional_fields)* - fs_type mount_source super_options
  // The `-` separator terminates the optional fields list. Fields 1..5 are
  // always in fixed positions; everything after the `-` is the post-split
  // half (fs_type, mount_source, super_options).
  const parts = line.split(" ");
  if (parts.length < 10) return null;

  const mountPoint = parts[4];
  if (mountPoint !== WORKSPACE_MOUNT_POINT) return null;

  const separatorIdx = parts.indexOf("-", 6);
  if (separatorIdx < 0 || separatorIdx + 2 >= parts.length) return null;

  const mountSource = parts[separatorIdx + 2];
  if (mountSource === undefined) return null;

  const match = DOCKER_VOLUME_SOURCE_RE.exec(mountSource);
  if (match === null) return null;
  return match[1] ?? null;
}
