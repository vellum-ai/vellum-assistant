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
 * copy. A removal nulls the notification field too, and falls back to nulling
 * the display avatar alone, so a platform that rejects the notification field
 * cannot block clearing the avatar. Its key carries the spec version as the
 * non-empty key does, so an installation still holding the key of a removal
 * that predates the notification field re-sends once instead of deduping
 * against it and leaving a disc up that nothing else clears.
 * The same PATCH carries `notification_avatar_base64`, the disc render the
 * push pipeline shows as the sender. The dedup key carries the accent,
 * `NOTIFICATION_AVATAR_SPEC_VERSION` and whether a disc can be drawn at all,
 * rather than the render's digest, so a change to the disc spec still
 * re-uploads an unchanged raster without the key costing a render on every
 * enqueue; the render itself happens inside the lazy body, only for a payload
 * that is actually going out. Folding in the render availability is what
 * keeps a sync that shipped only `avatar_base64` (no native rasterizer, no
 * codec for the source) from latching for the key's whole lifetime: the key
 * changes the moment the cause clears, so the disc goes up on the next sync.
 * When the render is unavailable the key is omitted rather than nulled, so
 * the platform keeps the copy it holds. The state is read through the accent
 * backfill, so a manifest written before accents were persisted has its
 * accent derived and stored before the key is built and the disc is drawn,
 * rather than shipping the neutral fallback until something else repairs it.
 * A render that fails inside the body, after the key promised a disc, hands
 * the queue the disc-less key instead, so the next sync tries again rather
 * than recording a disc that never went up. If the platform rejects the field
 * outright with a 400, the queue re-sends the display avatar alone, and under
 * the disc key: the 400 is a verdict on this render, so re-drawing it would
 * only take the same 400 on every later enqueue. The key still moves when the
 * raster, the accent or the spec does, which is when there is a different
 * render to offer.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { NOTIFICATION_AVATAR_SPEC_VERSION } from "@vellumai/avatar-manifest/notification-avatar";

import { backfillAccent } from "../avatar/accent-backfill.js";
import { readAvatarState } from "../avatar/avatar-manifest.js";
import {
  ensureAvatarRasterPath,
  readContainedAvatarRaster,
} from "../avatar/ensure-raster.js";
import {
  canRenderNotificationAvatar,
  renderNotificationAvatarPng,
  resolveNotificationAccentHex,
} from "../avatar/notification-avatar.js";
import {
  getResvg,
  isResvgAvailable,
  isResvgDecodableType,
  RESVG_DECODABLE_TYPES,
} from "../avatar/resvg-lazy.js";
import { detectMediaType } from "../tools/shared/filesystem/image-read.js";
import { getLogger } from "../util/logger.js";
import { getProtectedDir } from "../util/platform.js";
import {
  createPlatformPatchQueue,
  type PatchBodyResult,
  type PatchPayload,
  type PlatformPatchQueue,
  type SyncedKey,
} from "./platform-patch-queue.js";

const log = getLogger("sync-avatar");

/** Largest raster sent as-is; bigger ones are downscaled first. */
const MAX_AVATAR_UPLOAD_BYTES = 256 * 1024;
const DOWNSCALE_PX = 128;
const NONE_KEY = "none";
const DISC_KEY = "disc";
/** The removal payload's key, versioned with the disc spec it also clears. */
const REMOVAL_KEY = `${NONE_KEY}:${NOTIFICATION_AVATAR_SPEC_VERSION}`;
/** The PATCH field carrying the disc, and what a 400 rejecting it names. */
const NOTIFICATION_FIELD = "notification_avatar_base64";
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
  const state = await backfillAccent(readAvatarState());
  if (state.kind === "none") {
    return {
      key: REMOVAL_KEY,
      // A removal that had to drop the notification field still records
      // REMOVAL_KEY, as the non-empty reduced send records its full body's key.
      body: async () => withNotificationFallback({ avatar_base64: null }, null),
    };
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
  const digest = sha256(bytes);
  const accentHex = resolveNotificationAccentHex(state);
  const keyFor = (disc: string): string =>
    `${state.kind}:${digest}:${NOTIFICATION_AVATAR_SPEC_VERSION}:${accentHex ?? NONE_KEY}:${disc}`;
  return {
    key: keyFor(
      (await canRenderNotificationAvatar(bytes)) ? DISC_KEY : NONE_KEY,
    ),
    body: async () => {
      const encoded = encodeForUpload(bytes);
      if (encoded === undefined) {
        log.warn(
          { bytes: bytes.length, cap: MAX_AVATAR_UPLOAD_BYTES },
          "Avatar raster exceeds upload cap and could not be downscaled; skipping sync",
        );
        return undefined;
      }
      const rasterOnly = { avatar_base64: encoded };
      const notification = await renderNotificationAvatarPng(state, bytes);
      if (!notification) {
        // Nothing was drawn, so the disc-less key goes up and the next sync
        // draws again.
        return { body: rasterOnly, key: keyFor(NONE_KEY) };
      }
      // A 400 is the platform refusing this render rather than missing it,
      // so the reduced send records the disc key: re-drawing would take the
      // same 400 on every later enqueue.
      return withNotificationFallback(
        rasterOnly,
        notification.toString("base64"),
        keyFor(DISC_KEY),
      );
    },
  };
}

/** Pairs a body carrying the disc with the reduced send a 400 falls back to. */
function withNotificationFallback(
  displayOnly: { avatar_base64: string | null },
  notification: string | null,
  key?: string,
): PatchBodyResult {
  return {
    body: { ...displayOnly, notification_avatar_base64: notification },
    key,
    retryWithout: { field: NOTIFICATION_FIELD, body: displayOnly, key },
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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
  if (!isResvgDecodableType(mediaType)) {
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
