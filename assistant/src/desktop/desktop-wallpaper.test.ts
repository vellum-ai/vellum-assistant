import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import sharp from "sharp";

import {
  __resetResvgCacheForTests,
  __setResvgCacheForTests,
} from "../avatar/resvg-lazy.js";
import {
  renderCurrentDesktopWallpaper,
  renderDesktopWallpaper,
} from "./desktop-wallpaper.js";

let workspace: string;
let previousWorkspace: string | undefined;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "desktop-wallpaper-test-"));
  previousWorkspace = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspace;
  mkdirSync(join(workspace, "data/avatar"), { recursive: true });
});
afterEach(() => {
  __resetResvgCacheForTests();
  if (previousWorkspace === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspace;
  }
  rmSync(workspace, { recursive: true, force: true });
});

function manifest(state: Record<string, unknown>): void {
  writeFileSync(
    join(workspace, "data/avatar/avatar.json"),
    JSON.stringify(state),
  );
}

async function centerPixel(png: Buffer): Promise<number[]> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset =
    (Math.round(info.height * 0.46) * info.width + info.width / 2) * 4;
  return [...data.subarray(offset, offset + 4)];
}

test("renders the current uploaded avatar into an opaque desktop wallpaper", async () => {
  const png = await sharp({
    create: { width: 32, height: 32, channels: 4, background: "#ff0000" },
  })
    .png()
    .toBuffer();
  writeFileSync(join(workspace, "data/avatar/avatar-image.png"), png);
  manifest({
    kind: "image",
    source: "upload",
    traits: null,
    image: { updatedAt: "2026-01-01T00:00:00Z", etag: "test" },
    accent: null,
  });
  const result = (await renderCurrentDesktopWallpaper(480, 300))!;
  expect(await centerPixel(result)).toEqual([255, 0, 0, 255]);
  const metadata = await sharp(result).metadata();
  expect([metadata.width, metadata.height]).toEqual([480, 300]);
  expect((await sharp(result).stats()).isOpaque).toBe(true);
});

test("regenerates a character from current traits when its raster is missing", async () => {
  manifest({
    kind: "character",
    source: "pool",
    traits: { bodyShape: "blob", eyeStyle: "curious", color: "green" },
    image: null,
    accent: null,
  });
  const result = (await renderCurrentDesktopWallpaper(480, 300))!;
  const empty = renderDesktopWallpaper(480, 300, null, null);
  expect(await centerPixel(result)).not.toEqual(await centerPixel(empty));
});

test("missing and unreadable avatars produce the same neutral background", async () => {
  const missing = await renderCurrentDesktopWallpaper(480, 300);
  manifest({
    kind: "image",
    source: "upload",
    traits: null,
    image: { updatedAt: "2026-01-01T00:00:00Z", etag: "test" },
    accent: null,
  });
  writeFileSync(
    join(workspace, "data/avatar/avatar-image.png"),
    "not an image",
  );
  expect(await renderCurrentDesktopWallpaper(480, 300)).toEqual(missing);
  expect((await sharp(missing!).stats()).isOpaque).toBe(true);
});

test("accent changes tint the background and malformed accents fall back safely", async () => {
  const neutral = renderDesktopWallpaper(480, 300, null, null);
  expect(
    renderDesktopWallpaper(480, 300, null, '\"/><image href="file:///test"/>'),
  ).toEqual(neutral);
  const red = await centerPixel(
    renderDesktopWallpaper(480, 300, null, "#ff0000"),
  );
  const blue = await centerPixel(
    renderDesktopWallpaper(480, 300, null, "#0000ff"),
  );
  expect(red[0]!).toBeGreaterThan(blue[0]!);
  expect(blue[2]!).toBeGreaterThan(red[2]!);
});

test("a missing native renderer leaves the existing desktop background alone", async () => {
  __setResvgCacheForTests({
    available: false,
    error: new Error("unavailable"),
  });
  expect(await renderCurrentDesktopWallpaper(480, 300)).toBeNull();
});

async function wordmarkPixels(
  png: Buffer,
): Promise<{ x: number; y: number }[]> {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels: { x: number; y: number }[] = [];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * info.channels;
      if (
        data[offset]! > 150 &&
        data[offset + 1]! > 150 &&
        data[offset + 2]! > 150
      ) {
        pixels.push({ x, y });
      }
    }
  }
  return pixels;
}

test("renders the current identity name and picks up a rename on the next refresh", async () => {
  const identity = join(workspace, "IDENTITY.md");
  writeFileSync(identity, "- **Name:** Alice\n");
  const first = (await renderCurrentDesktopWallpaper(480, 300))!;
  expect(first).toEqual(renderDesktopWallpaper(480, 300, null, null, "Alice"));
  const pixels = await wordmarkPixels(first);
  expect(pixels.length).toBeGreaterThan(100);
  expect(pixels.every(({ y }) => y > 300 * 0.6 && y < 300 * 0.72)).toBe(true);

  writeFileSync(identity, "- **Name:** Bob\n");
  const renamed = await renderCurrentDesktopWallpaper(480, 300);
  expect(renamed).not.toEqual(first);
  expect(renamed).toEqual(renderDesktopWallpaper(480, 300, null, null, "Bob"));
});

test("an unset or template identity displays Vellum OS", async () => {
  const fallback = renderDesktopWallpaper(480, 300, null, null, "Vellum");
  expect(await renderCurrentDesktopWallpaper(480, 300)).toEqual(fallback);
  writeFileSync(
    join(workspace, "IDENTITY.md"),
    "- **Name:** _(not yet chosen)_\n",
  );
  expect(await renderCurrentDesktopWallpaper(480, 300)).toEqual(fallback);
});

test("long names fit inside the wallpaper without losing the wordmark", async () => {
  const png = renderDesktopWallpaper(480, 300, null, null, "W".repeat(32));
  const pixels = await wordmarkPixels(png);
  expect(pixels.length).toBeGreaterThan(100);
  expect(pixels.every(({ x }) => x > 480 * 0.13 && x < 480 * 0.87)).toBe(true);
});

test("names containing XML are rendered as text without injecting SVG shapes", async () => {
  const name =
    'Alice & </text><rect width="480" height="300" fill="red"/><text>';
  const png = renderDesktopWallpaper(480, 300, null, null, name);
  const fallback = renderDesktopWallpaper(480, 300, null, null);
  const top = { left: 0, top: 0, width: 480, height: 150 };
  expect(await sharp(png).extract(top).raw().toBuffer()).toEqual(
    await sharp(fallback).extract(top).raw().toBuffer(),
  );
  expect((await wordmarkPixels(png)).length).toBeGreaterThan(0);
});
