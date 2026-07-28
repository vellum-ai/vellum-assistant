import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  checkPluginIcons,
  generatePluginIcons,
  isTransientUpstreamStatus,
  validatePluginIconBytes,
} from "../generate-plugin-icons.mjs";

// The assistant validator is the source of truth for the byte format; assert
// the mirrored .mjs validator agrees with it on the same inputs. (The transient
// classifier is covered separately below without a TS import — plugin-marketplace.ts
// pulls in zod, which this install-free CI job cannot resolve.)
import { validatePluginIconBytes as tsValidate } from "../../../assistant/src/cli/lib/plugin-icon-file.ts";

/** Build a minimal but structurally valid PNG with the given IHDR dimensions. */
function makePng(width, height, { padTo = 0 } = {}) {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13);
  const ihdrType = Buffer.from("IHDR", "ascii");
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type (RGBA)
  let buf = Buffer.concat([magic, ihdrLen, ihdrType, ihdrData]);
  if (padTo > buf.length) {
    buf = Buffer.concat([buf, Buffer.alloc(padTo - buf.length)]);
  }
  return buf;
}

const sha16 = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

/** A fetch stub keyed by GitHub Contents URL substring `<repo>`. */
function stubFetch(byRepo) {
  return async (url) => {
    const match = Object.keys(byRepo).find((repo) => url.includes(`/repos/${repo}/`));
    const entry = match ? byRepo[match] : undefined;
    if (!entry) {
      return { ok: false, status: 404 };
    }
    if (typeof entry.status === "number" && entry.status !== 200) {
      return { ok: false, status: entry.status };
    }
    const bytes = entry.bytes;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
}

let dir;
let marketplacePath;
let assetsDir;
let manifestPath;

function writeMarketplace(plugins) {
  writeFileSync(
    marketplacePath,
    JSON.stringify({ name: "vellum-assistant", plugins }, null, 2),
  );
}

function pluginEntry(name, repo, extra = {}) {
  return {
    name,
    source: {
      source: "github",
      repo,
      ref: "a".repeat(40),
      ...extra,
    },
  };
}

const run = (fetch) =>
  generatePluginIcons({
    fetch,
    marketplacePath,
    assetsDir,
    manifestPath,
    token: undefined,
    log: { log() {}, warn() {} },
  });

const check = () => checkPluginIcons({ assetsDir, manifestPath });

const readManifest = () => JSON.parse(readFileSync(manifestPath, "utf-8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plugin-icons-"));
  marketplacePath = join(dir, "marketplace.json");
  assetsDir = join(dir, "assets");
  manifestPath = join(dir, "plugin-icons.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("validatePluginIconBytes mirrors the assistant validator", () => {
  test("agrees with the TS validator across cases", () => {
    const cases = [
      makePng(64, 64),
      makePng(128, 128),
      makePng(129, 64), // oversized dimension
      makePng(64, 64, { padTo: 32 * 1024 + 1 }), // oversized bytes
      Buffer.from("not a png at all, definitely not"),
    ];
    for (const bytes of cases) {
      expect(validatePluginIconBytes(bytes)).toEqual(tsValidate(bytes));
    }
  });
});

describe("isTransientUpstreamStatus mirrors the assistant classifier", () => {
  // Spec: `isTransientUpstreamStatus` in
  // assistant/src/cli/lib/plugin-marketplace.ts — 429/5xx always transient; a
  // 403 is transient only when the rate-limit quota header is exhausted.
  test("classifies statuses per the TS spec", () => {
    const res = (status, headers = {}) => ({ status, headers: new Headers(headers) });
    const cases = [
      [res(200), false],
      [res(403), false], // hard authorization failure — quota not exhausted
      [res(403, { "x-ratelimit-remaining": "0" }), true], // rate-limit signal
      [res(404), false],
      [res(408), false],
      [res(429), true],
      [res(500), true],
      [res(503), true],
    ];
    for (const [r, expected] of cases) {
      expect(isTransientUpstreamStatus(r)).toBe(expected);
    }
  });
});

describe("generatePluginIcons (write mode)", () => {
  test("oversized Content-Length skips+prunes only that plugin, without buffering", async () => {
    // Pre-seed a stale vendored icon for the plugin that will report oversized —
    // it must be pruned, not left stale.
    mkdirSync(join(assetsDir, "big"), { recursive: true });
    writeFileSync(join(assetsDir, "big", "icon.png"), makePng(16, 16));

    const good = makePng(64, 64);
    writeMarketplace([
      pluginEntry("big", "owner/big"),
      pluginEntry("good", "owner/good"),
    ]);

    let bigBuffered = false;
    const fetch = async (url) => {
      if (url.includes("/repos/owner/big/")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-length": String(32 * 1024 + 1) }),
          arrayBuffer: async () => {
            bigBuffered = true;
            return new ArrayBuffer(0);
          },
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () =>
          good.buffer.slice(good.byteOffset, good.byteOffset + good.byteLength),
      };
    };

    const result = await run(fetch);

    // Oversized body was never materialized.
    expect(bigBuffered).toBe(false);
    // Only the oversized plugin is skipped; the other is still vendored.
    expect(result.vendored).toEqual(["good"]);
    expect(result.skipped).toEqual(["big"]);
    expect(readFileSync(join(assetsDir, "good", "icon.png")).equals(good)).toBe(true);
    expect(readManifest().plugins).toEqual({ good: { iconVersion: sha16(good) } });
    // Stale vendored icon for the oversized plugin was pruned.
    let bigExists = true;
    try {
      readFileSync(join(assetsDir, "big", "icon.png"));
    } catch {
      bigExists = false;
    }
    expect(bigExists).toBe(false);
  });

  test("aborts on an entry name that fails PLUGIN_NAME_RE, writing nothing", async () => {
    // A traversal-y name must never become a path segment; the run aborts before
    // any fetch or write, and nothing is written outside plugins/assets/.
    writeMarketplace([pluginEntry("../evil", "owner/evil")]);

    let fetched = false;
    const fetch = async () => {
      fetched = true;
      return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
    };

    await expect(run(fetch)).rejects.toThrow(/invalid plugin name/);
    expect(fetched).toBe(false);
    // No stray asset written anywhere under the temp dir (e.g. a sibling of assets/).
    let escaped = true;
    try {
      readFileSync(join(dir, "evil", "icon.png"));
    } catch {
      escaped = false;
    }
    expect(escaped).toBe(false);
  });

  test("valid PNG is vendored and indexed with the correct iconVersion", async () => {
    const png = makePng(64, 64);
    writeMarketplace([pluginEntry("good", "owner/good")]);

    const result = await run(stubFetch({ "owner/good": { bytes: png } }));

    expect(result.vendored).toEqual(["good"]);
    const vendored = readFileSync(join(assetsDir, "good", "icon.png"));
    expect(vendored.equals(png)).toBe(true);
    expect(readManifest()).toEqual({
      version: 1,
      plugins: { good: { iconVersion: sha16(png) } },
    });
  });

  test("oversized/invalid PNG is skipped, not vendored, absent from manifest", async () => {
    const huge = makePng(64, 64, { padTo: 32 * 1024 + 1 });
    writeMarketplace([pluginEntry("big", "owner/big")]);

    const result = await run(stubFetch({ "owner/big": { bytes: huge } }));

    expect(result.vendored).toEqual([]);
    expect(result.skipped).toEqual(["big"]);
    expect(readManifest().plugins).toEqual({});
  });

  test("missing icon (404) is absent from the manifest", async () => {
    writeMarketplace([pluginEntry("none", "owner/none")]);

    const result = await run(stubFetch({}));

    expect(result.skipped).toEqual(["none"]);
    expect(readManifest().plugins).toEqual({});
  });

  for (const status of [500, 429]) {
    test(`transient HTTP ${status} aborts without mutating assets/manifest`, async () => {
      // Pre-seed a valid vendored icon + manifest for a plugin that will fail
      // transiently: the run must NOT prune it.
      const existing = makePng(64, 64);
      mkdirSync(join(assetsDir, "keep"), { recursive: true });
      writeFileSync(join(assetsDir, "keep", "icon.png"), existing);
      writeFileSync(
        manifestPath,
        `${JSON.stringify(
          { version: 1, plugins: { keep: { iconVersion: sha16(existing) } } },
          null,
          2,
        )}\n`,
      );

      writeMarketplace([pluginEntry("keep", "owner/keep")]);

      await expect(
        run(stubFetch({ "owner/keep": { status } })),
      ).rejects.toThrow(/Aborting icon generation/);

      // Working tree untouched: existing icon + manifest survive verbatim.
      expect(readFileSync(join(assetsDir, "keep", "icon.png")).equals(existing)).toBe(
        true,
      );
      expect(readManifest().plugins).toEqual({ keep: { iconVersion: sha16(existing) } });
    });
  }

  test("a network/DNS throw aborts and leaves the tree unchanged", async () => {
    const existing = makePng(48, 48);
    mkdirSync(join(assetsDir, "keep"), { recursive: true });
    writeFileSync(join(assetsDir, "keep", "icon.png"), existing);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        { version: 1, plugins: { keep: { iconVersion: sha16(existing) } } },
        null,
        2,
      )}\n`,
    );
    writeMarketplace([pluginEntry("keep", "owner/keep")]);

    const throwingFetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    };

    await expect(run(throwingFetch)).rejects.toThrow(/Aborting icon generation/);
    expect(readFileSync(join(assetsDir, "keep", "icon.png")).equals(existing)).toBe(
      true,
    );
    expect(readManifest().plugins).toEqual({ keep: { iconVersion: sha16(existing) } });
  });

  test("a transient failure does not vendor an earlier-processed plugin", async () => {
    // "alpha" fetches fine, "bravo" fails transiently: alpha must not be
    // written to disk since the whole run aborts before any mutation.
    writeMarketplace([
      pluginEntry("alpha", "owner/alpha"),
      pluginEntry("bravo", "owner/bravo"),
    ]);

    await expect(
      run(
        stubFetch({
          "owner/alpha": { bytes: makePng(32, 32) },
          "owner/bravo": { status: 503 },
        }),
      ),
    ).rejects.toThrow(/Aborting icon generation/);

    let alphaExists = true;
    try {
      readFileSync(join(assetsDir, "alpha", "icon.png"));
    } catch {
      alphaExists = false;
    }
    expect(alphaExists).toBe(false);
  });

  test("respects source.path when building the fetch URL", async () => {
    const png = makePng(32, 32);
    writeMarketplace([pluginEntry("nested", "owner/mono", { path: "sub/dir" })]);

    let requestedUrl;
    const fetch = async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
      };
    };

    await run(fetch);
    expect(requestedUrl).toContain("/repos/owner/mono/contents/sub/dir/icon.png");
  });

  test("prunes stale asset dirs for plugins that lost/never had an icon", async () => {
    // Pre-seed a stale vendored asset for a plugin absent from the marketplace.
    mkdirSync(join(assetsDir, "stale"), { recursive: true });
    writeFileSync(join(assetsDir, "stale", "icon.png"), makePng(16, 16));

    const png = makePng(48, 48);
    writeMarketplace([pluginEntry("keep", "owner/keep")]);

    await run(stubFetch({ "owner/keep": { bytes: png } }));

    expect(check().ok).toBe(true);
    expect(readManifest().plugins).toEqual({ keep: { iconVersion: sha16(png) } });
    // Stale dir removed.
    let staleExists = true;
    try {
      readFileSync(join(assetsDir, "stale", "icon.png"));
    } catch {
      staleExists = false;
    }
    expect(staleExists).toBe(false);
  });

  test("output is deterministic across runs", async () => {
    writeMarketplace([
      pluginEntry("bravo", "owner/bravo"),
      pluginEntry("alpha", "owner/alpha"),
    ]);
    const fetch = stubFetch({
      "owner/alpha": { bytes: makePng(20, 20) },
      "owner/bravo": { bytes: makePng(30, 30) },
    });

    await run(fetch);
    const first = readFileSync(manifestPath, "utf-8");
    await run(fetch);
    const second = readFileSync(manifestPath, "utf-8");

    expect(first).toBe(second);
    // Names sorted, trailing newline.
    expect(first.endsWith("\n")).toBe(true);
    expect(first.indexOf('"alpha"')).toBeLessThan(first.indexOf('"bravo"'));
  });
});

describe("checkPluginIcons (check mode)", () => {
  test("passes on a consistent tree", async () => {
    writeMarketplace([pluginEntry("good", "owner/good")]);
    await run(stubFetch({ "owner/good": { bytes: makePng(64, 64) } }));

    expect(check()).toEqual({ ok: true, errors: [] });
  });

  test("fails on a hand-mutated manifest iconVersion", async () => {
    writeMarketplace([pluginEntry("good", "owner/good")]);
    await run(stubFetch({ "owner/good": { bytes: makePng(64, 64) } }));

    const manifest = readManifest();
    manifest.plugins.good.iconVersion = "0000000000000000";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = check();
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("iconVersion mismatch");
  });

  test("fails on an orphan manifest entry with no asset", async () => {
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ version: 1, plugins: { ghost: { iconVersion: "abc" } } }, null, 2)}\n`,
    );

    const result = check();
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("no vendored asset");
  });

  test("fails on an unlisted asset dir", async () => {
    mkdirSync(join(assetsDir, "surprise"), { recursive: true });
    writeFileSync(join(assetsDir, "surprise", "icon.png"), makePng(16, 16));
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ version: 1, plugins: {} }, null, 2)}\n`,
    );

    const result = check();
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("not listed in the manifest");
  });

  test("fails on a hash-matching but non-PNG vendored asset", async () => {
    // A malformed blob committed as icon.png, with the manifest hash tuned to
    // match it — the hash check alone would pass; contract validation must not.
    const bogus = Buffer.from("this is not a png but has a matching hash!!");
    mkdirSync(join(assetsDir, "evil"), { recursive: true });
    writeFileSync(join(assetsDir, "evil", "icon.png"), bogus);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        { version: 1, plugins: { evil: { iconVersion: sha16(bogus) } } },
        null,
        2,
      )}\n`,
    );

    const result = check();
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("not a contract-valid PNG");
  });

  test("fails on a hash-matching but oversized vendored asset", async () => {
    const huge = makePng(64, 64, { padTo: 32 * 1024 + 1 });
    mkdirSync(join(assetsDir, "big"), { recursive: true });
    writeFileSync(join(assetsDir, "big", "icon.png"), huge);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        { version: 1, plugins: { big: { iconVersion: sha16(huge) } } },
        null,
        2,
      )}\n`,
    );

    const result = check();
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("not a contract-valid PNG");
  });
});
