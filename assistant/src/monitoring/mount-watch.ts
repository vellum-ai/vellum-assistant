/**
 * Mount-table watcher for the assistant container, polled by the resource
 * monitor.
 *
 * The monitor process shares the assistant container's mount namespace, so
 * `/proc/self/mountinfo` is exactly that container's mounts (workspace and
 * data PVC binds, plus any virtiofs handles). Gateway and CES sidecar mounts
 * are out of scope. The watcher keeps a baseline and logs only when the
 * watched set actually changes: a virtiofs bind that disappears, a fstype
 * swap, or a statfs size collapse on `/workspace` or `/data`.
 *
 * Windows and macOS have no `/proc/self/mountinfo`; those platforms no-op.
 */

import { readFileSync, statfsSync } from "node:fs";

import type { MonitoringConfig } from "../config/schemas/monitoring.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("mount-watch");

/** Assistant-container PVC bind targets in the managed pod template. */
export const ASSISTANT_VOLUME_MOUNT_POINTS = ["/workspace", "/data"] as const;

const VIRTIOFS_TYPES = new Set(["virtiofs", "fuse.virtiofs"]);

export interface MountInfoEntry {
  mountId: string;
  parentId: string;
  majorMinor: string;
  root: string;
  mountPoint: string;
  mountOptions: string;
  fsType: string;
  source: string;
  superOptions: string;
}

export interface PathFsSnapshot {
  path: string;
  /** `statfs.f_type`; null when the path could not be measured. */
  type: number | null;
  blockSize: number | null;
  blocks: number | null;
  files: number | null;
  /** Present when the path exists but `statfs` failed. */
  error?: string;
}

export interface MountSnapshot {
  mounts: MountInfoEntry[];
  paths: PathFsSnapshot[];
}

export interface MountDiff {
  added: MountInfoEntry[];
  removed: MountInfoEntry[];
  changed: Array<{ previous: MountInfoEntry; current: MountInfoEntry }>;
  pathChanges: Array<{ previous: PathFsSnapshot; current: PathFsSnapshot }>;
}

export interface CollectMountSnapshotOptions {
  platform?: NodeJS.Platform;
  readMountinfo?: () => string;
  statPath?: (path: string) => PathFsSnapshot;
  watchedMountPoints?: readonly string[];
}

export interface MountWatchHandle {
  stop: () => void;
}

/**
 * Kernel mountinfo encodes space/tab/newline in paths as octal escapes
 * (`\040`, `\011`, `\012`) and a backslash as `\\`.
 */
export function unescapeMountField(value: string): string {
  return value
    .replace(/\\([0-7]{3})/g, (_match, oct: string) =>
      String.fromCharCode(parseInt(oct, 8)),
    )
    .replace(/\\\\/g, "\\");
}

/**
 * Parse `/proc/self/mountinfo` into structured entries. Malformed lines are
 * skipped rather than failing the pass.
 */
export function parseMountinfo(raw: string): MountInfoEntry[] {
  const entries: MountInfoEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const separator = line.indexOf(" - ");
    if (separator < 0) {
      continue;
    }
    const left = line.slice(0, separator).split(" ");
    const right = line.slice(separator + 3).split(" ");
    if (left.length < 6 || right.length < 3) {
      continue;
    }
    entries.push({
      mountId: left[0],
      parentId: left[1],
      majorMinor: left[2],
      root: unescapeMountField(left[3]),
      mountPoint: unescapeMountField(left[4]),
      mountOptions: left[5],
      fsType: unescapeMountField(right[0]),
      source: unescapeMountField(right[1]),
      superOptions: right.slice(2).join(" "),
    });
  }
  return entries;
}

export function isWatchedMount(
  entry: MountInfoEntry,
  watchedMountPoints: readonly string[] = ASSISTANT_VOLUME_MOUNT_POINTS,
): boolean {
  if (VIRTIOFS_TYPES.has(entry.fsType)) {
    return true;
  }
  return watchedMountPoints.some(
    (point) => entry.mountPoint === point || entry.mountPoint.startsWith(`${point}/`),
  );
}

function mountIdentity(entry: MountInfoEntry): string {
  return entry.mountPoint;
}

function mountSignature(entry: MountInfoEntry): string {
  return [
    entry.fsType,
    entry.source,
    entry.majorMinor,
    entry.root,
    entry.mountOptions,
    entry.superOptions,
  ].join("\0");
}

function pathSignature(snapshot: PathFsSnapshot): string {
  return [
    String(snapshot.type),
    String(snapshot.blockSize),
    String(snapshot.blocks),
    String(snapshot.files),
    snapshot.error ?? "",
  ].join("\0");
}

export function diffMountSnapshots(
  previous: MountSnapshot,
  current: MountSnapshot,
): MountDiff {
  const prevByPoint = new Map(
    previous.mounts.map((entry) => [mountIdentity(entry), entry]),
  );
  const currentByPoint = new Map(
    current.mounts.map((entry) => [mountIdentity(entry), entry]),
  );

  const added: MountInfoEntry[] = [];
  const removed: MountInfoEntry[] = [];
  const changed: Array<{ previous: MountInfoEntry; current: MountInfoEntry }> =
    [];

  for (const [point, entry] of currentByPoint) {
    const prior = prevByPoint.get(point);
    if (prior == null) {
      added.push(entry);
      continue;
    }
    if (mountSignature(prior) !== mountSignature(entry)) {
      changed.push({ previous: prior, current: entry });
    }
  }
  for (const [point, entry] of prevByPoint) {
    if (!currentByPoint.has(point)) {
      removed.push(entry);
    }
  }

  const prevPaths = new Map(previous.paths.map((row) => [row.path, row]));
  const pathChanges: Array<{
    previous: PathFsSnapshot;
    current: PathFsSnapshot;
  }> = [];
  for (const row of current.paths) {
    const prior = prevPaths.get(row.path);
    if (prior != null && pathSignature(prior) !== pathSignature(row)) {
      pathChanges.push({ previous: prior, current: row });
    }
  }

  return { added, removed, changed, pathChanges };
}

export function mountDiffIsEmpty(diff: MountDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    diff.pathChanges.length === 0
  );
}

function defaultReadMountinfo(): string {
  return readFileSync("/proc/self/mountinfo", "utf8");
}

function defaultStatPath(path: string): PathFsSnapshot {
  try {
    const stats = statfsSync(path);
    return {
      path,
      type: Number(stats.type),
      blockSize: Number(stats.bsize),
      blocks: Number(stats.blocks),
      files: Number(stats.files),
    };
  } catch {
    return {
      path,
      type: null,
      blockSize: null,
      blocks: null,
      files: null,
      error: "statfs-failed",
    };
  }
}

/**
 * Snapshot the assistant container's watched mounts. Returns null on Windows
 * and macOS, or when `/proc/self/mountinfo` is unreadable.
 */
export function collectMountSnapshot(
  options: CollectMountSnapshotOptions = {},
): MountSnapshot | null {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" || platform === "darwin") {
    return null;
  }

  const watchedMountPoints =
    options.watchedMountPoints ?? ASSISTANT_VOLUME_MOUNT_POINTS;
  const readMountinfo = options.readMountinfo ?? defaultReadMountinfo;
  const statPath = options.statPath ?? defaultStatPath;

  let raw: string;
  try {
    raw = readMountinfo();
  } catch {
    return null;
  }

  const mounts = parseMountinfo(raw)
    .filter((entry) => isWatchedMount(entry, watchedMountPoints))
    .sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));

  const paths = watchedMountPoints.map((path) => statPath(path));

  return { mounts, paths };
}

function summarizeEntry(entry: MountInfoEntry): Record<string, string> {
  return {
    mountPoint: entry.mountPoint,
    fsType: entry.fsType,
    source: entry.source,
    majorMinor: entry.majorMinor,
  };
}

function summarizePath(snapshot: PathFsSnapshot): Record<string, unknown> {
  return {
    path: snapshot.path,
    type: snapshot.type,
    blockSize: snapshot.blockSize,
    blocks: snapshot.blocks,
    files: snapshot.files,
    ...(snapshot.error != null ? { error: snapshot.error } : {}),
  };
}

export function logMountDiff(diff: MountDiff): void {
  log.warn(
    {
      added: diff.added.map(summarizeEntry),
      removed: diff.removed.map(summarizeEntry),
      changed: diff.changed.map((row) => ({
        previous: summarizeEntry(row.previous),
        current: summarizeEntry(row.current),
      })),
      pathChanges: diff.pathChanges.map((row) => ({
        previous: summarizePath(row.previous),
        current: summarizePath(row.current),
      })),
    },
    "Assistant container mount table changed",
  );
}

/**
 * Start the mount poller. The first pass establishes a silent baseline so a
 * healthy boot does not log; later passes warn only when the watched mounts
 * or `/workspace`/`/data` statfs values change.
 *
 * The timer is unref'd: the resource sampler is the monitor process's
 * keep-alive, and this loop must not extend its life on its own.
 */
export function startMountWatch(
  config: MonitoringConfig,
  options: CollectMountSnapshotOptions = {},
): MountWatchHandle {
  let previous: MountSnapshot | null = null;

  const poll = () => {
    try {
      const snapshot = collectMountSnapshot(options);
      if (snapshot == null) {
        return;
      }
      if (previous != null) {
        const diff = diffMountSnapshots(previous, snapshot);
        if (!mountDiffIsEmpty(diff)) {
          logMountDiff(diff);
        }
      }
      previous = snapshot;
    } catch (err) {
      log.warn({ err }, "Mount-watch poll failed");
    }
  };

  poll();
  const timer = setInterval(poll, config.mountWatchIntervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}
