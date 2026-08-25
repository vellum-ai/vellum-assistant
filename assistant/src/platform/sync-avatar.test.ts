import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AvatarState } from "../avatar/avatar-manifest.js";

let mockState: AvatarState;
let mockRasterPath: string | null;
let mockClient: {
  platformAssistantId: string;
  fetch: (path: string, init: RequestInit) => Promise<Response>;
} | null;
let mockResvgAvailable = false;
let mockRenderedPng = Buffer.from("small");
let rasterCalls = 0;

mock.module("./client.js", () => ({
  VellumPlatformClient: { create: async () => mockClient },
}));

mock.module("../avatar/avatar-manifest.js", () => ({
  readManifest: () => mockState,
  deriveStateFromLegacyFiles: () => mockState,
  computeImageMeta: () => ({ updatedAt: "", etag: "stat-etag" }),
}));

mock.module("../avatar/ensure-raster.js", () => ({
  ensureAvatarRasterPath: async () => {
    rasterCalls += 1;
    return mockRasterPath;
  },
}));

mock.module("../avatar/resvg-lazy.js", () => ({
  isResvgAvailable: () => mockResvgAvailable,
  getResvg: () =>
    class {
      render() {
        return { asPng: () => mockRenderedPng };
      }
    },
}));

import {
  _resetSyncAvatarStateForTests,
  MAX_AVATAR_UPLOAD_BYTES,
  syncAvatarToPlatform,
} from "./sync-avatar.js";

const dir = mkdtempSync(join(tmpdir(), "sync-avatar-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeRaster(name: string, bytes: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

function imageState(etag: string): AvatarState {
  return {
    kind: "image",
    traits: null,
    source: "upload",
    image: { updatedAt: "2026-01-01T00:00:00.000Z", etag },
  };
}

const NONE: AvatarState = { kind: "none", traits: null, source: null, image: null };

interface Patch {
  path: string;
  body: { avatar_base64: string | null };
}

let patches: Patch[];
let respond: () => Response;

function makeClient(assistantId = "asst-1") {
  return {
    platformAssistantId: assistantId,
    fetch: async (path: string, init: RequestInit) => {
      patches.push({ path, body: JSON.parse(init.body as string) });
      return respond();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("syncAvatarToPlatform", () => {
  beforeEach(() => {
    _resetSyncAvatarStateForTests();
    patches = [];
    rasterCalls = 0;
    respond = () => new Response("{}", { status: 200 });
    mockClient = makeClient();
    mockResvgAvailable = false;
    mockState = imageState("etag-a");
    mockRasterPath = writeRaster("a.png", Buffer.from("png-a"));
  });

  test("PATCHes the base64 raster once and dedups an unchanged etag", async () => {
    syncAvatarToPlatform();
    await settle();
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe("/v1/assistants/asst-1/");
    expect(patches[0].body).toEqual({
      avatar_base64: Buffer.from("png-a").toString("base64"),
    });
  });

  test("a changed etag re-sends", async () => {
    syncAvatarToPlatform();
    await settle();
    mockState = imageState("etag-b");
    mockRasterPath = writeRaster("b.png", Buffer.from("png-b"));
    syncAvatarToPlatform();
    await settle();

    expect(patches.map((p) => p.body.avatar_base64)).toEqual([
      Buffer.from("png-a").toString("base64"),
      Buffer.from("png-b").toString("base64"),
    ]);
  });

  test("rapid changes collapse into one PATCH carrying the newest raster", async () => {
    syncAvatarToPlatform();
    syncAvatarToPlatform();
    mockState = imageState("etag-c");
    mockRasterPath = writeRaster("c.png", Buffer.from("png-c"));
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(1);
    expect(patches[0].body.avatar_base64).toBe(
      Buffer.from("png-c").toString("base64"),
    );
    expect(rasterCalls).toBe(1);
  });

  test("removing the avatar sends avatar_base64: null", async () => {
    syncAvatarToPlatform();
    await settle();
    mockState = NONE;
    mockRasterPath = null;
    syncAvatarToPlatform();
    await settle();

    expect(patches[1].body).toEqual({ avatar_base64: null });
  });

  test("skips oversized rasters when resvg is unavailable", async () => {
    mockRasterPath = writeRaster(
      "big.png",
      Buffer.alloc(MAX_AVATAR_UPLOAD_BYTES + 1),
    );
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(0);
  });

  test("downscales oversized rasters through resvg", async () => {
    mockResvgAvailable = true;
    mockRenderedPng = Buffer.from("tiny");
    mockRasterPath = writeRaster(
      "big.png",
      Buffer.alloc(MAX_AVATAR_UPLOAD_BYTES + 1),
    );
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(1);
    expect(patches[0].body.avatar_base64).toBe(
      Buffer.from("tiny").toString("base64"),
    );
  });

  test("skips when the downscaled raster still exceeds the cap", async () => {
    mockResvgAvailable = true;
    mockRenderedPng = Buffer.alloc(MAX_AVATAR_UPLOAD_BYTES + 1);
    mockRasterPath = writeRaster(
      "big.png",
      Buffer.alloc(MAX_AVATAR_UPLOAD_BYTES + 1),
    );
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(0);
  });

  test("no-op without a platform client or assistant id", async () => {
    mockClient = null;
    syncAvatarToPlatform();
    await settle();
    mockClient = makeClient("");
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(0);
    expect(rasterCalls).toBe(0);
  });

  test("a failed PATCH does not dedup the next attempt", async () => {
    respond = () => new Response("nope", { status: 500 });
    syncAvatarToPlatform();
    await settle();
    respond = () => new Response("{}", { status: 200 });
    syncAvatarToPlatform();
    await settle();
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(2);
  });

  test("a thrown fetch is swallowed and retried on the next publish", async () => {
    mockClient = {
      platformAssistantId: "asst-1",
      fetch: async () => {
        throw new Error("boom");
      },
    };
    syncAvatarToPlatform();
    await settle();
    mockClient = makeClient();
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(1);
  });
});
