/**
 * Sync the avatar raster to the platform Assistant record.
 *
 * Every avatar publish (routes and the fs watcher) and daemon startup enqueue
 * a sync through the shared platform PATCH queue. The current avatar state is
 * read when the request runs, so rapid changes collapse into one PATCH
 * carrying the newest raster. The dedup key comes from the raster file itself,
 * not the manifest, so a raster rewritten in place (fs watcher path) still
 * syncs. The last synced key is persisted outside the workspace repo at
 * `<protected dir>/platform-sync/avatar.json` so a daemon restart does not
 * re-upload an unchanged raster and the record never dirties the workspace.
 * A synced key older than `AVATAR_SYNC_KEY_TTL_MS` does not dedup, whether
 * seeded from disk or set in-process, and the queue re-enqueues itself when
 * the key expires, so an avatar lost server-side while id and base URL are
 * unchanged is re-pushed within a week even by a daemon that never restarts
 * (API-key auth cannot read the record to verify it).
 * `avatar_base64: null` is sent only when the avatar is actually removed; a
 * non-none avatar whose raster is missing (image PNG gone, character
 * re-render unavailable) is skipped so the platform keeps the last synced
 * copy.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { readAvatarState } from "../avatar/avatar-manifest.js";
import {
  ensureAvatarRasterPath,
  readContainedAvatarRaster,
} from "../avatar/ensure-raster.js";
import { getResvg, isResvgAvailable } from "../avatar/resvg-lazy.js";
import { detectMediaType } from "../tools/shared/filesystem/image-read.js";
import { getLogger } from "../util/logger.js";
import { getProtectedDir } from "../util/platform.js";
import {
  createPlatformPatchQueue,
  type PatchPayload,
  type PlatformPatchQueue,
  type SyncedKey,
} from "./platform-patch-queue.js";

const log = getLogger("sync-avatar");

/** Largest raster sent as-is; bigger ones are downscaled first. */
const MAX_AVATAR_UPLOAD_BYTES = 256 * 1024;
const DOWNSCALE_PX = 128;
const NONE_KEY = "none";
/** Raster formats resvg decodes inside an `<image>`; anything else renders blank. */
const RESVG_DECODABLE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
]);
/** Only bytes that sniff as a raster image are ever uploaded. */
const UPLOADABLE_TYPES: ReadonlySet<string> = new Set([
  ...RESVG_DECODABLE_TYPES,
  "image/webp",
]);
const SYNC_STATE_SUBPATH = ["platform-sync", "avatar.json"];
export const AVATAR_SYNC_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let queue: PlatformPatchQueue<void> | null = null;

/** Recreates the queue so the next sync re-seeds its dedup key from disk. */
export function _resetSyncAvatarStateForTests(): void {
  queue?.dispose();
  queue = null;
}

/**
 * Enqueue a best-effort push of the current avatar raster to the platform.
 * No-op when the platform client cannot be created or no assistant id is
 * configured, or when the raster's etag matches the last successful sync.
 */
export function syncAvatarToPlatform(): void {
  queue ??= createPlatformPatchQueue({
    log,
    label: "avatar",
    buildPayload,
    loadSyncedKey: readPersistedKey,
    saveSyncedKey: persistKey,
    maxAgeMs: AVATAR_SYNC_KEY_TTL_MS,
  });
  queue.enqueue();
}

function syncStatePath(): string {
  return join(getProtectedDir(), ...SYNC_STATE_SUBPATH);
}

/** Returns the persisted key, or null when missing or malformed. */
function readPersistedKey(): SyncedKey | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(syncStatePath(), "utf-8"));
    const { key, syncedAt } = (parsed ?? {}) as {
      key?: unknown;
      syncedAt?: unknown;
    };
    if (typeof key !== "string" || typeof syncedAt !== "number") {
      return null;
    }
    return { key, syncedAt };
  } catch {
    return null;
  }
}

function persistKey(synced: SyncedKey): void {
  try {
    const path = syncStatePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp.${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(synced));
    renameSync(tmpPath, path);
  } catch (err) {
    log.warn({ err }, "Failed to persist avatar sync state");
  }
}

async function buildPayload(): Promise<PatchPayload | undefined> {
  const state = readAvatarState();
  if (state.kind === "none") {
    return { key: NONE_KEY, body: { avatar_base64: null } };
  }
  const path = await ensureAvatarRasterPath(state);
  if (!path) {
    log.warn({ kind: state.kind }, "Avatar raster missing; skipping sync");
    return undefined;
  }
  const bytes = readRaster(path);
  if (!bytes) {
    return undefined;
  }
  // Keyed on content so a same-size, same-mtime rewrite still re-syncs.
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    key: `${state.kind}:${digest}`,
    body: async () => {
      const encoded = encodeForUpload(bytes);
      if (encoded === undefined) {
        log.warn(
          { bytes: bytes.length, cap: MAX_AVATAR_UPLOAD_BYTES },
          "Avatar raster exceeds upload cap and could not be downscaled; skipping sync",
        );
        return undefined;
      }
      return { avatar_base64: encoded };
    },
  };
}

/**
 * Reads the raster through the fd-validated, avatar-dir-contained path and
 * refuses anything that does not sniff as an image, so a symlinked or
 * swapped `avatar-image.png` never ships host bytes to the platform.
 */
function readRaster(path: string): Buffer | undefined {
  const bytes = readContainedAvatarRaster(path);
  if (!bytes) {
    log.warn(
      { path },
      "Avatar raster unreadable or not contained; skipping sync",
    );
    return undefined;
  }
  const mediaType = detectMediaType(bytes);
  if (mediaType === null || !UPLOADABLE_TYPES.has(mediaType)) {
    log.warn({ mediaType }, "Avatar raster is not an image; skipping sync");
    return undefined;
  }
  return bytes;
}

function downscaleRaster(bytes: Buffer): Buffer | null {
  if (!isResvgAvailable()) {
    return null;
  }
  const mediaType = detectMediaType(bytes);
  if (mediaType === null || !RESVG_DECODABLE_TYPES.has(mediaType)) {
    log.warn(
      { mediaType },
      "Avatar raster format is not decodable by resvg; skipping downscale",
    );
    return null;
  }
  const href = `data:${mediaType};base64,${bytes.toString("base64")}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${DOWNSCALE_PX}" height="${DOWNSCALE_PX}" viewBox="0 0 ${DOWNSCALE_PX} ${DOWNSCALE_PX}">` +
    `<image width="${DOWNSCALE_PX}" height="${DOWNSCALE_PX}" preserveAspectRatio="xMidYMid meet" href="${href}" xlink:href="${href}"/></svg>`;
  const Resvg = getResvg();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: DOWNSCALE_PX },
  });
  return Buffer.from(resvg.render().asPng());
}

/** Returns the base64 payload, or undefined when the raster cannot fit the cap. */
function encodeForUpload(bytes: Buffer): string | undefined {
  let upload: Buffer | null = bytes;
  if (upload.length > MAX_AVATAR_UPLOAD_BYTES) {
    upload = downscaleRaster(upload);
  }
  if (!upload || upload.length > MAX_AVATAR_UPLOAD_BYTES) {
    return undefined;
  }
  return upload.toString("base64");
}
