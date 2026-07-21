import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  addPluginIcon,
  isCuratedEmoji,
  parseArgs,
  serializeMarketplace,
} from "../add-plugin-icon.mjs";

const COFFEE = String.fromCodePoint(0x2615); // ☕
const BONE = String.fromCodePoint(0x1f9b4); // 🦴  (outside the BMP → surrogate pair)
const EM_DASH = String.fromCodePoint(0x2014); // —

const quietLog = { log() {}, warn() {} };

let dir;
let marketplacePath;

/** Canonical marketplace fixture written via the tool's own serializer. */
function writeMarketplace(plugins) {
  const data = { name: "vellum-assistant", plugins };
  writeFileSync(marketplacePath, serializeMarketplace(data));
  return data;
}

function entry(name, extra = {}) {
  return {
    name,
    source: { source: "github", repo: `owner/${name}`, ref: "a".repeat(40) },
    description: `The ${name} plugin ${EM_DASH} does things.`,
    license: "MIT",
    ...extra,
  };
}

/** A generator stub that vendors the given names; records call count. */
function stubGenerate(vendored = [], skipped = []) {
  const calls = { n: 0 };
  const fn = async () => {
    calls.n++;
    return { vendored, skipped };
  };
  return [fn, calls];
}

function stubSync() {
  const calls = { n: 0 };
  return [async () => void calls.n++, calls];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "add-plugin-icon-"));
  marketplacePath = join(dir, "marketplace.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("serializeMarketplace", () => {
  test("emits raw human-readable UTF-8 (no \\uXXXX escaping) and a trailing newline", () => {
    const out = serializeMarketplace({ plugins: [entry("coffee", { icon: COFFEE })] });
    expect(out.endsWith("\n")).toBe(true);
    // Emoji + em-dash are kept raw, never escaped.
    expect(out.includes(COFFEE)).toBe(true);
    expect(out.includes(EM_DASH)).toBe(true);
    expect(out).not.toContain("\\u2615");
    expect(out).not.toContain("\\u2014");
  });

  test("emits astral emoji raw, not as a surrogate-pair escape", () => {
    const out = serializeMarketplace({ plugins: [entry("caveman", { icon: BONE })] });
    expect(out.includes(BONE)).toBe(true);
    expect(out).not.toContain("\\ud83e\\uddb4");
  });

  test("is a stable round-trip of its own output", () => {
    const first = serializeMarketplace({
      name: "vellum-assistant",
      plugins: [entry("a", { icon: COFFEE }), entry("b")],
    });
    const second = serializeMarketplace(JSON.parse(first));
    expect(second).toBe(first);
  });
});

describe("isCuratedEmoji", () => {
  // Must match the `icon` refinement in marketplaceEntrySchema
  // (assistant/src/cli/lib/plugin-marketplace.ts) so this tool never writes a
  // value the reader later rejects.
  // 👨‍👩‍👧‍👦 = 4 emoji joined by 3 ZWJ (U+200D) → 7 code points.
  const ZWJ = String.fromCodePoint(0x200d);
  const FAMILY = [0x1f468, 0x1f469, 0x1f467, 0x1f466]
    .map((cp) => String.fromCodePoint(cp))
    .join(ZWJ);

  test("accepts emoji glyphs, including multi-code-point sequences", () => {
    expect(isCuratedEmoji(COFFEE)).toBe(true);
    expect(isCuratedEmoji(BONE)).toBe(true);
    expect(isCuratedEmoji(FAMILY)).toBe(true); // 7 code points ≤ 8
  });

  test("rejects URLs, slashes, over-length, and empties (schema parity)", () => {
    expect(isCuratedEmoji("")).toBe(false);
    expect(isCuratedEmoji(undefined)).toBe(false);
    expect(isCuratedEmoji("/icons/x.png")).toBe(false);
    expect(isCuratedEmoji("https://example.com/x.png")).toBe(false);
    expect(isCuratedEmoji("HTTPS://example.com/x.png")).toBe(false); // case-insensitive
    expect(isCuratedEmoji("http://x")).toBe(false);
    expect(isCuratedEmoji("a\\b")).toBe(false); // backslash anywhere
    expect(isCuratedEmoji(`${COFFEE}/x`)).toBe(false); // slash not just leading
    expect(isCuratedEmoji("not-an-emoji-just-text")).toBe(false); // > 8 code points
    expect(isCuratedEmoji(COFFEE.repeat(9))).toBe(false); // 9 code points
  });
});

describe("addPluginIcon", () => {
  test("sets the emoji surgically, leaving other entries byte-identical", async () => {
    const data = writeMarketplace([entry("alpha"), entry("coffee"), entry("bravo")]);
    const before = readFileSync(marketplacePath, "utf-8");
    const [gen, genCalls] = stubGenerate(["coffee"]);
    const [sync, syncCalls] = stubSync();

    const result = await addPluginIcon({
      name: "coffee",
      emoji: COFFEE,
      marketplacePath,
      runGenerate: gen,
      runSync: sync,
      log: quietLog,
    });

    const after = readFileSync(marketplacePath, "utf-8");
    // Exactly the change of setting coffee.icon = ☕, nothing else.
    data.plugins[1].icon = COFFEE;
    expect(after).toBe(serializeMarketplace(data));
    // The emoji is written raw, and the only textual delta is the added icon line.
    expect(after).toContain(COFFEE);
    const removedUnchanged = before
      .split("\n")
      .filter((l) => !after.split("\n").includes(l));
    expect(removedUnchanged).toEqual([]); // no line was removed/altered, only added

    expect(result.emojiChanged).toBe(true);
    expect(result.vendored).toBe(true);
    expect(genCalls.n).toBe(1);
    expect(syncCalls.n).toBe(1);
  });

  test("is a no-op on the file when the emoji is already set, but still refreshes", async () => {
    writeMarketplace([entry("coffee", { icon: COFFEE })]);
    const before = readFileSync(marketplacePath, "utf-8");
    const [gen, genCalls] = stubGenerate(["coffee"]);
    const [sync, syncCalls] = stubSync();

    const result = await addPluginIcon({
      name: "coffee",
      emoji: COFFEE,
      marketplacePath,
      runGenerate: gen,
      runSync: sync,
      log: quietLog,
    });

    expect(readFileSync(marketplacePath, "utf-8")).toBe(before);
    expect(result.emojiChanged).toBe(false);
    // Vendor refresh + sync still run — the point of a re-run.
    expect(genCalls.n).toBe(1);
    expect(syncCalls.n).toBe(1);
  });

  test("without --emoji, never touches marketplace.json but still vendors+syncs", async () => {
    writeMarketplace([entry("coffee")]);
    const before = readFileSync(marketplacePath, "utf-8");
    const [gen, genCalls] = stubGenerate([], ["coffee"]);
    const [sync, syncCalls] = stubSync();

    const result = await addPluginIcon({
      name: "coffee",
      marketplacePath,
      runGenerate: gen,
      runSync: sync,
      log: quietLog,
    });

    expect(readFileSync(marketplacePath, "utf-8")).toBe(before);
    expect(result.emojiChanged).toBe(false);
    expect(result.vendored).toBe(false);
    expect(result.skipped).toBe(true);
    expect(genCalls.n).toBe(1);
    expect(syncCalls.n).toBe(1);
  });

  test("throws for a plugin absent from the marketplace, without vendoring", async () => {
    writeMarketplace([entry("coffee")]);
    const [gen, genCalls] = stubGenerate();
    const [sync, syncCalls] = stubSync();

    await expect(
      addPluginIcon({
        name: "ghost",
        emoji: COFFEE,
        marketplacePath,
        runGenerate: gen,
        runSync: sync,
        log: quietLog,
      }),
    ).rejects.toThrow(/is not in/);
    expect(genCalls.n).toBe(0);
    expect(syncCalls.n).toBe(0);
  });

  test("rejects a URL/path emoji before doing anything", async () => {
    writeMarketplace([entry("coffee")]);
    const before = readFileSync(marketplacePath, "utf-8");
    const [gen, genCalls] = stubGenerate();
    const [sync, syncCalls] = stubSync();

    await expect(
      addPluginIcon({
        name: "coffee",
        emoji: "https://example.com/x.png",
        marketplacePath,
        runGenerate: gen,
        runSync: sync,
        log: quietLog,
      }),
    ).rejects.toThrow(/short emoji/);
    expect(readFileSync(marketplacePath, "utf-8")).toBe(before);
    expect(genCalls.n).toBe(0);
    expect(syncCalls.n).toBe(0);
  });

  test("refuses to rewrite a non-canonical marketplace.json", async () => {
    // 4-space indent → not the canonical form our serializer emits.
    writeFileSync(
      marketplacePath,
      JSON.stringify({ name: "x", plugins: [entry("coffee")] }, null, 4) + "\n",
    );
    const before = readFileSync(marketplacePath, "utf-8");
    const [gen, genCalls] = stubGenerate();
    const [sync, syncCalls] = stubSync();

    await expect(
      addPluginIcon({
        name: "coffee",
        emoji: COFFEE,
        marketplacePath,
        runGenerate: gen,
        runSync: sync,
        log: quietLog,
      }),
    ).rejects.toThrow(/canonical/);
    expect(readFileSync(marketplacePath, "utf-8")).toBe(before);
    expect(genCalls.n).toBe(0);
    expect(syncCalls.n).toBe(0);
  });

  test("a generator abort leaves marketplace.json untouched and skips sync", async () => {
    writeMarketplace([entry("coffee")]);
    const before = readFileSync(marketplacePath, "utf-8");
    const [sync, syncCalls] = stubSync();

    await expect(
      addPluginIcon({
        name: "coffee",
        emoji: COFFEE,
        marketplacePath,
        runGenerate: async () => {
          throw new Error("Aborting icon generation: transient");
        },
        runSync: sync,
        log: quietLog,
      }),
    ).rejects.toThrow(/Aborting icon generation/);

    // Emoji write happens only AFTER a successful generate — so the abort
    // leaves the file pristine and never runs the sync.
    expect(readFileSync(marketplacePath, "utf-8")).toBe(before);
    expect(syncCalls.n).toBe(0);
  });
});

describe("parseArgs", () => {
  test("parses name and --emoji in both forms", () => {
    expect(parseArgs(["coffee"])).toEqual({ name: "coffee", emoji: undefined });
    expect(parseArgs(["coffee", "--emoji", COFFEE])).toEqual({
      name: "coffee",
      emoji: COFFEE,
    });
    expect(parseArgs(["coffee", `--emoji=${COFFEE}`])).toEqual({
      name: "coffee",
      emoji: COFFEE,
    });
  });

  test("--help short-circuits", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["-h"])).toEqual({ help: true });
  });

  test("rejects a dangling --emoji, unknown flags, and extra args", () => {
    expect(() => parseArgs(["coffee", "--emoji"])).toThrow(/requires a value/);
    expect(() => parseArgs(["coffee", "--bogus"])).toThrow(/Unknown flag/);
    expect(() => parseArgs(["coffee", "extra"])).toThrow(/extra argument/);
  });
});
