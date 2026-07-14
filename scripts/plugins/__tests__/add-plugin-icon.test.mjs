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
  test("escapes non-ASCII (emoji, punctuation) and ends with a newline", () => {
    const out = serializeMarketplace({ plugins: [entry("coffee", { icon: COFFEE })] });
    expect(out.endsWith("\n")).toBe(true);
    // Emoji + em-dash are ASCII-escaped, never emitted raw.
    expect(out).toContain("\\u2615");
    expect(out).toContain("\\u2014");
    expect(out.includes(COFFEE)).toBe(false);
    expect(out.includes(EM_DASH)).toBe(false);
  });

  test("escapes astral emoji as a surrogate pair", () => {
    const out = serializeMarketplace({ plugins: [entry("caveman", { icon: BONE })] });
    expect(out).toContain("\\ud83e\\uddb4");
    expect(out.includes(BONE)).toBe(false);
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
  test("accepts emoji glyphs, rejects URLs/paths/empties", () => {
    expect(isCuratedEmoji(COFFEE)).toBe(true);
    expect(isCuratedEmoji(BONE)).toBe(true);
    expect(isCuratedEmoji("")).toBe(false);
    expect(isCuratedEmoji("/icons/x.png")).toBe(false);
    expect(isCuratedEmoji("https://example.com/x.png")).toBe(false);
    expect(isCuratedEmoji("http://x")).toBe(false);
    expect(isCuratedEmoji(undefined)).toBe(false);
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
    // The emoji is escaped, and the only textual delta is the added icon line.
    expect(after).toContain("\\u2615");
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
    ).rejects.toThrow(/emoji glyph/);
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
