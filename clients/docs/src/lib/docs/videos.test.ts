import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import {
  DOCS_VIDEOS,
  formatDuration,
  formatWatchTime,
  isoDuration,
  watchUrl,
} from "@/lib/docs/videos";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PUBLIC_ROOT = join(ROOT, "public");

const entries = Object.entries(DOCS_VIDEOS);

describe("DOCS_VIDEOS", () => {
  test.each(entries)("%s has a poster committed under public/docs", (_slug, video) => {
    expect(video.poster).toStartWith("/docs/");
    expect(video.poster).toEndWith(".webp");
    expect(existsSync(join(PUBLIC_ROOT, video.poster))).toBe(true);
  });

  test.each(entries)("%s carries usable metadata", (_slug, video) => {
    expect(video.youtubeId).toMatch(/^[\w-]{11}$/);
    expect(video.title.trim()).not.toBe("");
    expect(video.description.trim()).not.toBe("");
    expect(video.durationSeconds).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(video.uploadDate))).toBe(false);
  });

  test("no two entries point at the same video", () => {
    const ids = entries.map(([, video]) => video.youtubeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no two entries share a poster", () => {
    const posters = entries.map(([, video]) => video.poster);
    expect(new Set(posters).size).toBe(posters.length);
  });
});

describe("watchUrl", () => {
  test("builds the canonical watch URL", () => {
    expect(watchUrl(DOCS_VIDEOS["local-hosting-setup"])).toBe(
      "https://www.youtube.com/watch?v=SJgflx6XDeQ"
    );
  });
});

describe("duration formatting", () => {
  test("pads the seconds in the poster badge", () => {
    expect(formatDuration(205)).toBe("3:25");
    expect(formatDuration(181)).toBe("3:01");
    expect(formatDuration(600)).toBe("10:00");
  });

  test("rounds the prose watch time to the nearest minute", () => {
    expect(formatWatchTime(205)).toBe("3 min watch");
    expect(formatWatchTime(227)).toBe("4 min watch");
  });

  test("never rounds a short video down to zero minutes", () => {
    expect(formatWatchTime(20)).toBe("1 min watch");
  });

  test("emits ISO 8601 durations for structured data", () => {
    expect(isoDuration(205)).toBe("PT3M25S");
    expect(isoDuration(180)).toBe("PT3M0S");
  });
});
