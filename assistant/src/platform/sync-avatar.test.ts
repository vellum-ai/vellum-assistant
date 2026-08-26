import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";

import type { AvatarState } from "../avatar/avatar-manifest.js";
import * as realEnsureRaster from "../avatar/ensure-raster.js";

// Captured before mock.module swaps the module so the real, fd-validated
// read path is what the sync exercises.
const realReadContainedAvatarRaster =
  realEnsureRaster.readContainedAvatarRaster;

let mockState: AvatarState;
let mockRasterPath: string | null;
let mockClient: {
  baseUrl: string;
  platformAssistantId: string;
  fetch: (path: string, init: RequestInit) => Promise<Response>;
} | null;
let mockResvgAvailable = false;
let mockRenderedPng = Buffer.from("small");
let lastResvgSvg = "";
let rasterCalls = 0;

mock.module("./client.js", () => ({
  VellumPlatformClient: { create: async () => mockClient },
}));

mock.module("../avatar/avatar-manifest.js", () => ({
  readAvatarState: () => mockState,
  computeImageMeta: (path: string) => {
    const stats = statSync(path);
    return { updatedAt: "", etag: `${stats.size}:${stats.mtimeMs}` };
  },
}));

mock.module("../avatar/ensure-raster.js", () => ({
  ensureAvatarRasterPath: async () => {
    rasterCalls += 1;
    return mockRasterPath;
  },
  readContainedAvatarRaster: realReadContainedAvatarRaster,
}));

mock.module("../avatar/resvg-lazy.js", () => ({
  isResvgAvailable: () => mockResvgAvailable,
  getResvg: () =>
    class {
      constructor(svg: string) {
        lastResvgSvg = svg;
      }
      render() {
        return { asPng: () => mockRenderedPng };
      }
    },
}));

import {
  _resetSyncAvatarStateForTests,
  AVATAR_SYNC_KEY_TTL_MS,
  syncAvatarToPlatform,
} from "./sync-avatar.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Small PNG-signed raster whose tail makes the bytes distinguishable. */
function png(label: string): Buffer {
  return Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.from(`png-${label}`)]);
}

/** Just over the 256 KB upload cap, with a PNG signature. */
const OVERSIZED = withMagic(PNG_MAGIC);
const OVERSIZED_JPEG = withMagic([0xff, 0xd8, 0xff, 0xe0]);
const OVERSIZED_WEBP = withMagic([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]);

function withMagic(magic: number[]): Buffer<ArrayBuffer> {
  const buf = Buffer.alloc(256 * 1024 + 1);
  Buffer.from(magic).copy(buf);
  return buf;
}

const dir = mkdtempSync(join(tmpdir(), "sync-avatar-test-"));
const workspaceDir = join(dir, "workspace");
const avatarDir = join(workspaceDir, "data", "avatar");
const syncStatePath = join(dir, "protected", "platform-sync", "avatar.json");
const prevWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
afterAll(() => {
  if (prevWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = prevWorkspaceDir;
  }
  rmSync(dir, { recursive: true, force: true });
});

function writeRaster(name: string, bytes: Buffer): string {
  const path = join(avatarDir, name);
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

const NONE: AvatarState = {
  kind: "none",
  traits: null,
  source: null,
  image: null,
};

interface Patch {
  path: string;
  body: { avatar_base64: string | null };
}

let patches: Patch[];
let respond: () => Response;

function makeClient(assistantId = "asst-1", baseUrl = "https://platform.a") {
  return {
    baseUrl,
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
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(join(dir, "protected"), { recursive: true, force: true });
    mkdirSync(avatarDir, { recursive: true });
    _resetSyncAvatarStateForTests();
    patches = [];
    rasterCalls = 0;
    respond = () => new Response("{}", { status: 200 });
    mockClient = makeClient();
    mockResvgAvailable = false;
    mockState = imageState("etag-a");
    mockRasterPath = writeRaster("a.png", png("a"));
  });

  test("PATCHes the base64 raster once and dedups an unchanged etag", async () => {
    syncAvatarToPlatform();
    await settle();
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe("/v1/assistants/asst-1/");
    expect(patches[0].body).toEqual({
      avatar_base64: png("a").toString("base64"),
    });
  });

  test("a changed etag re-sends", async () => {
    syncAvatarToPlatform();
    await settle();
    mockState = imageState("etag-b");
    mockRasterPath = writeRaster("b.png", png("bb"));
    syncAvatarToPlatform();
    await settle();

    expect(patches.map((p) => p.body.avatar_base64)).toEqual([
      png("a").toString("base64"),
      png("bb").toString("base64"),
    ]);
  });

  test("a raster overwritten in place re-sends without a manifest change", async () => {
    syncAvatarToPlatform();
    await settle();
    writeRaster("a.png", png("a-rewritten"));
    syncAvatarToPlatform();
    await settle();

    expect(patches.map((p) => p.body.avatar_base64)).toEqual([
      png("a").toString("base64"),
      png("a-rewritten").toString("base64"),
    ]);
  });

  test("re-registering to another assistant id re-sends the same raster", async () => {
    syncAvatarToPlatform();
    await settle();
    mockClient = makeClient("asst-2");
    syncAvatarToPlatform();
    await settle();
    syncAvatarToPlatform();
    await settle();

    expect(patches.map((p) => p.path)).toEqual([
      "/v1/assistants/asst-1/",
      "/v1/assistants/asst-2/",
    ]);
    expect(patches[1].body.avatar_base64).toBe(png("a").toString("base64"));
  });

  test("rapid changes collapse into one PATCH carrying the newest raster", async () => {
    syncAvatarToPlatform();
    syncAvatarToPlatform();
    mockState = imageState("etag-c");
    mockRasterPath = writeRaster("c.png", png("c"));
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(1);
    expect(patches[0].body.avatar_base64).toBe(png("c").toString("base64"));
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

  test("an image avatar with a missing PNG is skipped, not cleared", async () => {
    syncAvatarToPlatform();
    await settle();
    mockRasterPath = null;
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(1);
  });

  test("a character whose re-render failed is skipped, not cleared", async () => {
    syncAvatarToPlatform();
    await settle();
    mockState = {
      kind: "character",
      traits: { bodyShape: "blob", eyeStyle: "curious", color: "green" },
      source: null,
      image: null,
    };
    mockRasterPath = null;
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(1);
  });

  test("a symlinked raster is never uploaded", async () => {
    const outside = join(dir, "outside.png");
    writeFileSync(outside, png("secret"));
    mockRasterPath = join(avatarDir, "avatar-image.png");
    symlinkSync(outside, mockRasterPath);
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(0);
  });

  test("a raster whose bytes are not an image is never uploaded", async () => {
    mockRasterPath = writeRaster(
      "avatar-image.png",
      Buffer.from("AKIA-not-an-image-at-all"),
    );
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(0);
  });

  test("a raster outside the avatar dir is never uploaded", async () => {
    const outside = join(dir, "elsewhere.png");
    writeFileSync(outside, png("elsewhere"));
    mockRasterPath = outside;
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(0);
  });

  test("skips oversized rasters when resvg is unavailable", async () => {
    mockRasterPath = writeRaster("big.png", OVERSIZED);
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(0);
  });

  test("downscales oversized rasters through resvg", async () => {
    mockResvgAvailable = true;
    mockRenderedPng = Buffer.from("tiny");
    mockRasterPath = writeRaster("big.png", OVERSIZED);
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(1);
    expect(patches[0].body.avatar_base64).toBe(
      Buffer.from("tiny").toString("base64"),
    );
  });

  test("downscales an oversized JPEG through resvg", async () => {
    mockResvgAvailable = true;
    mockRenderedPng = Buffer.from("tiny");
    mockRasterPath = writeRaster("big.png", OVERSIZED_JPEG);
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(1);
    expect(patches[0].body.avatar_base64).toBe(
      Buffer.from("tiny").toString("base64"),
    );
    expect(lastResvgSvg).toContain('href="data:image/jpeg;base64,');
  });

  test("skips an oversized WebP instead of uploading a blank render", async () => {
    mockResvgAvailable = true;
    mockRenderedPng = Buffer.from("tiny");
    lastResvgSvg = "";
    mockRasterPath = writeRaster("big.png", OVERSIZED_WEBP);
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(0);
    expect(lastResvgSvg).toBe("");
  });

  test("skips when the downscaled raster still exceeds the cap", async () => {
    mockResvgAvailable = true;
    mockRenderedPng = OVERSIZED;
    mockRasterPath = writeRaster("big.png", OVERSIZED);
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(0);
  });

  test("a restart with the same raster and destination does not re-upload", async () => {
    syncAvatarToPlatform();
    await settle();
    expect(JSON.parse(readFileSync(syncStatePath, "utf-8"))).toEqual({
      key: expect.stringMatching(/^https:\/\/platform\.a\|asst-1\|image:/),
      syncedAt: expect.any(Number),
    });
    expect(
      existsSync(join(workspaceDir, "data", "avatar", "avatar-sync.json")),
    ).toBe(false);

    _resetSyncAvatarStateForTests();
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(1);
  });

  test("a restart re-uploads when the destination or raster changed", async () => {
    syncAvatarToPlatform();
    await settle();

    _resetSyncAvatarStateForTests();
    mockClient = makeClient("asst-2");
    syncAvatarToPlatform();
    await settle();

    _resetSyncAvatarStateForTests();
    writeRaster("a.png", png("a-rewritten"));
    syncAvatarToPlatform();
    await settle();

    expect(patches.map((p) => p.path)).toEqual([
      "/v1/assistants/asst-1/",
      "/v1/assistants/asst-2/",
      "/v1/assistants/asst-2/",
    ]);
    expect(patches[2].body.avatar_base64).toBe(
      png("a-rewritten").toString("base64"),
    );
  });

  test("a persisted key older than the TTL re-uploads once and is refreshed", async () => {
    syncAvatarToPlatform();
    await settle();
    const stale = JSON.parse(readFileSync(syncStatePath, "utf-8"));
    stale.syncedAt = Date.now() - AVATAR_SYNC_KEY_TTL_MS - 24 * 60 * 60 * 1000;
    writeFileSync(syncStatePath, JSON.stringify(stale));

    _resetSyncAvatarStateForTests();
    syncAvatarToPlatform();
    await settle();
    _resetSyncAvatarStateForTests();
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(2);
    const refreshed = JSON.parse(readFileSync(syncStatePath, "utf-8"));
    expect(refreshed.key).toBe(stale.key);
    expect(refreshed.syncedAt).toBeGreaterThan(stale.syncedAt);
  });

  test("a key older than the TTL re-uploads without a restart", async () => {
    const start = Date.now();
    setSystemTime(new Date(start));
    try {
      syncAvatarToPlatform();
      await settle();
      setSystemTime(new Date(start + AVATAR_SYNC_KEY_TTL_MS - 1));
      syncAvatarToPlatform();
      await settle();
      expect(patches).toHaveLength(1);

      setSystemTime(new Date(start + AVATAR_SYNC_KEY_TTL_MS));
      syncAvatarToPlatform();
      await settle();
      syncAvatarToPlatform();
      await settle();
    } finally {
      setSystemTime();
    }

    expect(patches).toHaveLength(2);
    expect(JSON.parse(readFileSync(syncStatePath, "utf-8"))).toEqual({
      key: expect.stringMatching(/^https:\/\/platform\.a\|asst-1\|image:/),
      syncedAt: start + AVATAR_SYNC_KEY_TTL_MS,
    });
  });

  test("arms an unref'd timer that re-uploads at the TTL without a caller", async () => {
    const armed: Array<{ delay: number; fire: () => void }> = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      delay?: number,
    ) => {
      if (
        delay !== undefined &&
        delay > AVATAR_SYNC_KEY_TTL_MS - 1000 &&
        delay <= AVATAR_SYNC_KEY_TTL_MS
      ) {
        armed.push({ delay, fire: fn });
        return { unref: () => undefined } as unknown as NodeJS.Timeout;
      }
      return realSetTimeout(fn, delay);
    }) as typeof setTimeout);
    try {
      syncAvatarToPlatform();
      await settle();
      expect(patches).toHaveLength(1);
      expect(armed).toHaveLength(1);

      setSystemTime(new Date(Date.now() + AVATAR_SYNC_KEY_TTL_MS));
      armed[0]!.fire();
      await settle();
    } finally {
      spy.mockRestore();
      setSystemTime();
    }

    expect(patches).toHaveLength(2);
    expect(armed).toHaveLength(2);
  });

  test("a corrupt persisted key re-uploads", async () => {
    mkdirSync(dirname(syncStatePath), { recursive: true });
    writeFileSync(syncStatePath, "{not json");
    syncAvatarToPlatform();
    await settle();

    expect(patches).toHaveLength(1);
  });

  test("a failed PATCH leaves the persisted key untouched", async () => {
    respond = () => new Response("nope", { status: 500 });
    syncAvatarToPlatform();
    await settle();

    expect(() => readFileSync(syncStatePath)).toThrow();
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
});
