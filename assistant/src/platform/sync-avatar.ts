/**
 * Sync the avatar raster to the platform Assistant record.
 *
 * Every avatar publish (routes and the fs watcher) and daemon startup enqueue
 * a sync. The current avatar state is read when the request runs, so rapid
 * changes collapse into one PATCH carrying the newest raster. The dedup key
 * comes from the raster file itself, not the manifest, so a raster rewritten
 * in place (fs watcher path) still syncs, and is scoped to the platform
 * destination so re-registering to another assistant or base URL re-sends.
 * `avatar_base64: null` is sent only when the avatar is actually removed; a
 * non-none avatar whose raster is missing (image PNG gone, character re-render
 * unavailable) is skipped so the platform keeps the last synced copy.
 * Best-effort: failures are logged, never thrown, and leave the dedup key
 * untouched so the next publish retries.
 */

import { readFile } from "node:fs/promises";

import {
  computeImageMeta,
  readAvatarState,
} from "../avatar/avatar-manifest.js";
import { ensureAvatarRasterPath } from "../avatar/ensure-raster.js";
import { getResvg, isResvgAvailable } from "../avatar/resvg-lazy.js";
import { getLogger } from "../util/logger.js";
import { VellumPlatformClient } from "./client.js";

const log = getLogger("sync-avatar");

/** Largest raster sent as-is; bigger ones are downscaled first. */
export const MAX_AVATAR_UPLOAD_BYTES = 256 * 1024;
const DOWNSCALE_PX = 128;
const NONE_KEY = "none";

let lastSyncedKey: string | null = null;
let seq = 0;
let pending: Promise<void> = Promise.resolve();

export function _resetSyncAvatarStateForTests(): void {
  lastSyncedKey = null;
  seq = 0;
  pending = Promise.resolve();
}

/**
 * Enqueue a best-effort push of the current avatar raster to the platform.
 * No-op when the platform client cannot be created or no assistant id is
 * configured, or when the raster's etag matches the last successful sync.
 */
export function syncAvatarToPlatform(): void {
  const mySeq = ++seq;
  pending = pending.then(() => doSync(mySeq)).catch(() => {});
}

/** Returns undefined when a non-none avatar has no raster to send. */
async function readRaster(): Promise<
  { key: string; bytes: Buffer | null } | undefined
> {
  const state = readAvatarState();
  if (state.kind === "none") {
    return { key: NONE_KEY, bytes: null };
  }
  const path = await ensureAvatarRasterPath(state);
  if (!path) {
    log.warn({ kind: state.kind }, "Avatar raster missing; skipping sync");
    return undefined;
  }
  const { etag } = computeImageMeta(path);
  return { key: `${state.kind}:${etag}`, bytes: await readFile(path) };
}

function downscalePng(png: Buffer): Buffer | null {
  if (!isResvgAvailable()) {
    return null;
  }
  const href = `data:image/png;base64,${png.toString("base64")}`;
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
    upload = downscalePng(upload);
  }
  if (!upload || upload.length > MAX_AVATAR_UPLOAD_BYTES) {
    return undefined;
  }
  return upload.toString("base64");
}

async function doSync(requestSeq: number): Promise<void> {
  try {
    if (requestSeq !== seq) {
      return;
    }

    const client = await VellumPlatformClient.create();
    const assistantId = client?.platformAssistantId;
    if (!client || !assistantId) {
      return;
    }

    const raster = await readRaster();
    if (!raster) {
      return;
    }
    const { key: rasterKey, bytes } = raster;
    const key = `${client.baseUrl}|${assistantId}|${rasterKey}`;
    if (key === lastSyncedKey) {
      return;
    }

    let avatarBase64: string | null = null;
    if (bytes) {
      const encoded = encodeForUpload(bytes);
      if (encoded === undefined) {
        log.warn(
          { bytes: bytes.length, cap: MAX_AVATAR_UPLOAD_BYTES },
          "Avatar raster exceeds upload cap and could not be downscaled; skipping sync",
        );
        return;
      }
      avatarBase64 = encoded;
    }

    // A newer publish superseded this one while the raster was read; it will
    // carry the fresher state.
    if (requestSeq !== seq) {
      return;
    }

    const resp = await client.fetch(
      `/v1/assistants/${encodeURIComponent(assistantId)}/`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatar_base64: avatarBase64 }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (resp.ok) {
      lastSyncedKey = key;
      log.info({ key: rasterKey, assistantId }, "Synced avatar to platform");
    } else {
      const text = await resp.text();
      log.warn(
        { status: resp.status, body: text, assistantId },
        "Failed to sync avatar to platform",
      );
    }
  } catch (err) {
    log.warn({ err }, "Error syncing avatar to platform");
  }
}
