// Regenerates the emoji catalogs from upstream gemoji data.
//
// Outputs:
//   clients/shared/Features/Chat/EmojiCatalog.swift
//   apps/web/src/domains/chat/components/chat-composer/emoji-catalog.ts
//
// Run: bun run scripts/generate-emoji-catalog.ts
//
// Fetches github/gemoji db/emoji.json at GEMOJI_COMMIT on first run and caches it
// at scripts/data/gemoji.json (gitignored). Bump GEMOJI_COMMIT and delete the
// cached file to pick up newer gemoji data.
//
// Aliases per entry are the union of:
//   1. gemoji tags
//   2. tokenized description words (length >= 3, not in STOPWORDS, not equal to shortcode)
//   3. EXTRA_ALIASES hand-curated map (for emojis with counterintuitive gemoji names)
// Each gemoji alias gets its own row; the aliases array excludes the row's own shortcode.
// LEGACY_ALIASES preserve previously hand-maintained Swift shortcodes that gemoji removed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Run from repo root: `bun run scripts/generate-emoji-catalog.ts`.
const REPO_ROOT = process.cwd();
const GEMOJI_COMMIT = "0eca75db9301421efc8710baf7a7576793ae452a";
const GEMOJI_URL = `https://raw.githubusercontent.com/github/gemoji/${GEMOJI_COMMIT}/db/emoji.json`;
const GEMOJI_CACHE = resolve(REPO_ROOT, "scripts/data/gemoji.json");
const SWIFT_OUT = resolve(REPO_ROOT, "clients/shared/Features/Chat/EmojiCatalog.swift");
const TS_OUT = resolve(REPO_ROOT, "apps/web/src/domains/chat/components/chat-composer/emoji-catalog.ts");

interface GemojiEntry {
  emoji: string;
  description: string;
  category: string;
  aliases: string[];
  tags?: string[];
}

const STOPWORDS = new Set([
  "face", "person", "people", "man", "woman", "boy", "girl",
  "sign", "symbol", "mark", "button",
  "with", "of", "and", "or", "the", "to", "from",
  "in", "on", "at", "for", "by", "but", "are",
]);

// Hand-curated extras keyed by gemoji primary shortcode.
// Use sparingly — only when the gemoji name is famously counterintuitive
// AND tags/description don't surface common search terms.
const EXTRA_ALIASES: Record<string, string[]> = {
  triumph: ["huff", "huffing", "frustrated", "fed_up", "fuming", "mad", "angry_huff", "nose_steam"],
  sob: ["crying", "bawling", "weeping"],
  joy: ["lol", "laughing", "crying_laughing", "lmao", "dying"],
  rofl: ["rolling", "lmao"],
  weary: ["exhausted"],
  disappointed: ["bummed"],
  roll_eyes: ["eyeroll", "annoyed"],
  grimacing: ["awkward", "yikes"],
  sleeping: ["asleep", "snore"],
  pleading_face: ["puppy_eyes", "begging", "please"],
  sunglasses: ["cool", "swag"],
  thinking: ["hmm", "ponder"],
  skull: ["dead", "dying"],
  fire: ["lit", "hot"],
  "100": ["perfect", "full_marks", "hundred"],
  shrug: ["idk", "dunno"],
  pray: ["thanks", "please", "namaste", "high_five"],
  sweat_smile: ["nervous_laugh"],
  cry: ["tears", "sad"],
  heart_eyes: ["love", "in_love"],
};

// Shortcodes the previous hand-maintained Swift catalog carried that gemoji has since
// renamed/removed. Kept as separate catalog rows so users with muscle memory still find
// the emoji. Value is the canonical gemoji primary shortcode for the same emoji.
const LEGACY_ALIASES: Record<string, string> = {
  admission_tickets: "tickets",
  blue_circle: "large_blue_circle",
  camera_with_flash: "camera_flash",
  face_with_rolling_eyes: "roll_eyes",
  film_frames: "film_strip",
  first_place_medal: "1st_place_medal",
  flag_black: "black_flag",
  flag_white: "white_flag",
  guardian: "guard",
  heart_exclamation: "heavy_heart_exclamation",
  hugging_face: "hugs",
  left_facing_fist: "fist_left",
  lion_face: "lion",
  medal: "medal_sports",
  minus: "heavy_minus_sign",
  non_potable_water: "non-potable_water",
  person_frowning: "frowning_person",
  person_with_pouting_face: "pouting_face",
  plus: "heavy_plus_sign",
  red_flag: "triangular_flag_on_post",
  right_facing_fist: "fist_right",
  robot_face: "robot",
  rolling_eyes: "roll_eyes",
  second_place_medal: "2nd_place_medal",
  sleeping_accommodation: "sleeping_bed",
  thinking_face: "thinking",
  third_place_medal: "3rd_place_medal",
  wind_blowing_face: "wind_face",
};

interface CatalogRow {
  shortcode: string;
  emoji: string;
  aliases: string[];
}

function tokenize(description: string): string[] {
  return description
    .toLowerCase()
    .split(/[\s\-_]+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function buildCatalog(gemoji: GemojiEntry[]): CatalogRow[] {
  const rows: CatalogRow[] = [];

  for (const entry of gemoji) {
    if (!entry.aliases.length) continue;
    const primary = entry.aliases[0];
    const baseAliases = dedupe([
      ...(entry.tags ?? []),
      ...tokenize(entry.description),
      ...(EXTRA_ALIASES[primary] ?? []),
    ]);
    for (const shortcode of entry.aliases) {
      rows.push({
        shortcode,
        emoji: entry.emoji,
        aliases: baseAliases.filter((a) => a !== shortcode),
      });
    }
  }

  const byShortcode = new Map(rows.map((r) => [r.shortcode, r]));
  for (const [legacy, canonical] of Object.entries(LEGACY_ALIASES)) {
    const target = byShortcode.get(canonical);
    if (!target) {
      throw new Error(`Legacy alias '${legacy}' targets unknown canonical '${canonical}'`);
    }
    rows.push({
      shortcode: legacy,
      emoji: target.emoji,
      aliases: target.aliases.filter((a) => a !== legacy),
    });
  }

  rows.sort((a, b) => (a.shortcode < b.shortcode ? -1 : a.shortcode > b.shortcode ? 1 : 0));
  return rows;
}

function emojiToSwiftLiteral(emoji: string): string {
  const parts: string[] = [];
  for (const codePoint of emoji) {
    parts.push(`\\u{${codePoint.codePointAt(0)!.toString(16).toUpperCase()}}`);
  }
  return parts.join("");
}

function quoted(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function emitSwift(rows: CatalogRow[]): string {
  const lines: string[] = [
    "// AUTO-GENERATED by scripts/generate-emoji-catalog.ts. Do not edit by hand.",
    `// Source: github.com/github/gemoji @ ${GEMOJI_COMMIT}`,
    "// Run: bun run scripts/generate-emoji-catalog.ts",
    "",
    "import Foundation",
    "",
    "public struct EmojiEntry: Hashable, Identifiable {",
    "    public let shortcode: String",
    "    public let emoji: String",
    "    public let aliases: [String]",
    "",
    "    public var id: String { shortcode }",
    "",
    "    public init(shortcode: String, emoji: String, aliases: [String] = []) {",
    "        self.shortcode = shortcode",
    "        self.emoji = emoji",
    "        self.aliases = aliases",
    "    }",
    "}",
    "",
    "public enum EmojiCatalog {",
    "",
    "    public static let all: [EmojiEntry] = [",
  ];
  for (const r of rows) {
    const aliasesPart =
      r.aliases.length === 0 ? "" : `, aliases: [${r.aliases.map(quoted).join(", ")}]`;
    lines.push(
      `        EmojiEntry(shortcode: ${quoted(r.shortcode)}, emoji: "${emojiToSwiftLiteral(r.emoji)}"${aliasesPart}),`,
    );
  }
  lines.push("    ]");
  lines.push("");
  lines.push("    public static func search(query: String, limit: Int = 8) -> [EmojiEntry] {");
  lines.push("        let lowered = query.lowercased()");
  lines.push("        if lowered.isEmpty {");
  lines.push("            return Array(all.prefix(limit))");
  lines.push("        }");
  lines.push("        var shortcodePrefix: [EmojiEntry] = []");
  lines.push("        var shortcodeSubstring: [EmojiEntry] = []");
  lines.push("        var aliasPrefix: [EmojiEntry] = []");
  lines.push("        var aliasSubstring: [EmojiEntry] = []");
  lines.push("        var seen = Set<String>()");
  lines.push("        for entry in all {");
  lines.push("            if entry.shortcode.hasPrefix(lowered) {");
  lines.push("                shortcodePrefix.append(entry)");
  lines.push("                seen.insert(entry.shortcode)");
  lines.push("            } else if entry.shortcode.contains(lowered) {");
  lines.push("                shortcodeSubstring.append(entry)");
  lines.push("                seen.insert(entry.shortcode)");
  lines.push("            }");
  lines.push("        }");
  lines.push("        for entry in all where !seen.contains(entry.shortcode) {");
  lines.push("            var sawPrefix = false");
  lines.push("            var sawSubstring = false");
  lines.push("            for alias in entry.aliases {");
  lines.push("                if alias.hasPrefix(lowered) {");
  lines.push("                    sawPrefix = true");
  lines.push("                    break");
  lines.push("                }");
  lines.push("                if alias.contains(lowered) {");
  lines.push("                    sawSubstring = true");
  lines.push("                }");
  lines.push("            }");
  lines.push("            if sawPrefix {");
  lines.push("                aliasPrefix.append(entry)");
  lines.push("            } else if sawSubstring {");
  lines.push("                aliasSubstring.append(entry)");
  lines.push("            }");
  lines.push("        }");
  lines.push("        return Array((shortcodePrefix + shortcodeSubstring + aliasPrefix + aliasSubstring).prefix(limit))");
  lines.push("    }");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

function emitTS(rows: CatalogRow[]): string {
  const lines: string[] = [
    "// AUTO-GENERATED by scripts/generate-emoji-catalog.ts. Do not edit by hand.",
    `// Source: github.com/github/gemoji @ ${GEMOJI_COMMIT}`,
    "// Run: bun run scripts/generate-emoji-catalog.ts",
    "",
    "export interface EmojiEntry {",
    "  shortcode: string;",
    "  emoji: string;",
    "  aliases: string[];",
    "}",
    "",
    "export const EMOJI_CATALOG: EmojiEntry[] = [",
  ];
  for (const r of rows) {
    const aliasesPart =
      r.aliases.length === 0 ? "[]" : `[${r.aliases.map(quoted).join(", ")}]`;
    lines.push(
      `  { shortcode: ${quoted(r.shortcode)}, emoji: ${quoted(r.emoji)}, aliases: ${aliasesPart} },`,
    );
  }
  lines.push("];");
  lines.push("");
  lines.push("/**");
  lines.push(" * Returns emoji entries matching `query` (case-insensitive), capped at `limit`.");
  lines.push(" * Ranking: shortcode prefix → shortcode substring → alias prefix → alias substring.");
  lines.push(" * Each shortcode appears at most once in the result.");
  lines.push(" */");
  lines.push("export function searchEmoji(query: string, limit = 8): EmojiEntry[] {");
  lines.push("  if (!query) return EMOJI_CATALOG.slice(0, limit);");
  lines.push("  const lower = query.toLowerCase();");
  lines.push("  const shortcodePrefix: EmojiEntry[] = [];");
  lines.push("  const shortcodeSubstring: EmojiEntry[] = [];");
  lines.push("  const aliasPrefix: EmojiEntry[] = [];");
  lines.push("  const aliasSubstring: EmojiEntry[] = [];");
  lines.push("  const seen = new Set<string>();");
  lines.push("  for (const entry of EMOJI_CATALOG) {");
  lines.push("    if (entry.shortcode.startsWith(lower)) {");
  lines.push("      shortcodePrefix.push(entry);");
  lines.push("      seen.add(entry.shortcode);");
  lines.push("    } else if (entry.shortcode.includes(lower)) {");
  lines.push("      shortcodeSubstring.push(entry);");
  lines.push("      seen.add(entry.shortcode);");
  lines.push("    }");
  lines.push("  }");
  lines.push("  for (const entry of EMOJI_CATALOG) {");
  lines.push("    if (seen.has(entry.shortcode)) continue;");
  lines.push("    let sawPrefix = false;");
  lines.push("    let sawSubstring = false;");
  lines.push("    for (const alias of entry.aliases) {");
  lines.push("      if (alias.startsWith(lower)) {");
  lines.push("        sawPrefix = true;");
  lines.push("        break;");
  lines.push("      }");
  lines.push("      if (alias.includes(lower)) sawSubstring = true;");
  lines.push("    }");
  lines.push("    if (sawPrefix) aliasPrefix.push(entry);");
  lines.push("    else if (sawSubstring) aliasSubstring.push(entry);");
  lines.push("  }");
  lines.push("  return [...shortcodePrefix, ...shortcodeSubstring, ...aliasPrefix, ...aliasSubstring].slice(0, limit);");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

async function loadGemoji(): Promise<GemojiEntry[]> {
  if (!existsSync(GEMOJI_CACHE)) {
    console.log(`Fetching gemoji data from ${GEMOJI_URL}`);
    const res = await fetch(GEMOJI_URL);
    if (!res.ok) {
      throw new Error(`Failed to fetch gemoji: ${res.status} ${res.statusText}`);
    }
    mkdirSync(dirname(GEMOJI_CACHE), { recursive: true });
    writeFileSync(GEMOJI_CACHE, await res.text());
  }
  return JSON.parse(readFileSync(GEMOJI_CACHE, "utf8")) as GemojiEntry[];
}

async function main(): Promise<void> {
  const gemoji = await loadGemoji();
  const rows = buildCatalog(gemoji);
  writeFileSync(SWIFT_OUT, emitSwift(rows));
  writeFileSync(TS_OUT, emitTS(rows));
  console.log(`Wrote ${rows.length} entries to:\n  ${SWIFT_OUT}\n  ${TS_OUT}`);
}

main();
