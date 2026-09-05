// Regenerates the daemon's reaction emoji table from Slack's emoji data.
//
// Output:
//   assistant/src/messaging/reaction-emoji-table.generated.ts
//
// Run (from the repo root): bun run scripts/generate-reaction-emoji-table.ts
//
// Source: github.com/iamcal/emoji-data, the table Slack's emoji names are
// drawn from, so a reaction's `shortcode` name resolves to the same
// character the Slack client shows. Fetched at EMOJI_DATA_COMMIT on first
// run and cached at scripts/data/emoji-data.json (gitignored); bump the
// commit and delete the cache to pick up newer data.
//
// One row per emoji: every short name it answers to, its fully qualified
// character, and, where Slack offers `::skin-tone-2` through `-6`, the five
// toned variants in that order. Variants come from the source rather than
// from appending a modifier, because a multi-person sequence places the
// modifier inside the sequence, not at its end.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const REPO_ROOT = process.cwd();
const EMOJI_DATA_COMMIT = "097705020bcf82331c9ef10df3425aad15f5043c";
const EMOJI_DATA_URL = `https://raw.githubusercontent.com/iamcal/emoji-data/${EMOJI_DATA_COMMIT}/emoji.json`;
const EMOJI_DATA_CACHE = resolve(REPO_ROOT, "scripts/data/emoji-data.json");
const TS_OUT = resolve(
  REPO_ROOT,
  "assistant/src/messaging/reaction-emoji-table.generated.ts",
);

/** Slack's `::skin-tone-N` suffix, N from 2 to 6, names these modifiers in order. */
const SKIN_TONE_MODIFIERS = ["1F3FB", "1F3FC", "1F3FD", "1F3FE", "1F3FF"];

interface EmojiDataEntry {
  unified: string;
  short_name: string;
  short_names: string[];
  sort_order: number;
  skin_variations?: Record<string, { unified: string }>;
}

interface TableRow {
  names: string[];
  emoji: string;
  skins?: string[];
}

function characterOf(unified: string): string {
  return String.fromCodePoint(
    ...unified.split("-").map((h) => parseInt(h, 16)),
  );
}

function buildTable(entries: EmojiDataEntry[]): TableRow[] {
  const rows: TableRow[] = [];
  for (const entry of [...entries].sort(
    (a, b) => a.sort_order - b.sort_order,
  )) {
    const names = Array.from(new Set([entry.short_name, ...entry.short_names]));
    const variants = entry.skin_variations;
    const skins = variants
      ? SKIN_TONE_MODIFIERS.map((m) => variants[m]?.unified)
      : undefined;
    rows.push({
      names,
      emoji: characterOf(entry.unified),
      // Only a full run of five single-tone variants is addressable by
      // Slack's suffix; a row with pair-only variants gets none.
      ...(skins && skins.every((s): s is string => typeof s === "string")
        ? { skins: skins.map(characterOf) }
        : {}),
    });
  }
  const seen = new Map<string, string>();
  for (const row of rows) {
    for (const name of row.names) {
      const prior = seen.get(name);
      if (prior !== undefined && prior !== row.emoji) {
        throw new Error(`Short name '${name}' maps to two emoji`);
      }
      seen.set(name, row.emoji);
    }
  }
  return rows;
}

function emitTS(rows: TableRow[]): string {
  const lines = [
    "// GENERATED FILE. Do not edit by hand.",
    `// Source: github.com/iamcal/emoji-data @ ${EMOJI_DATA_COMMIT} (emoji.json)`,
    "// Regenerate: bun run scripts/generate-reaction-emoji-table.ts",
    "",
    "export interface ReactionEmojiTableRow {",
    "  /** Every short name the emoji answers to; the first is its primary name. */",
    "  names: readonly string[];",
    "  /** The fully qualified character. */",
    "  emoji: string;",
    "  /** Skin tone variants for `::skin-tone-2` through `::skin-tone-6`, in order. */",
    "  skins?: readonly string[];",
    "}",
    "",
    "export const REACTION_EMOJI_TABLE: readonly ReactionEmojiTableRow[] = [",
  ];
  for (const row of rows) {
    const skins = row.skins ? `, skins: ${JSON.stringify(row.skins)}` : "";
    lines.push(
      `  { names: ${JSON.stringify(row.names)}, emoji: ${JSON.stringify(row.emoji)}${skins} },`,
    );
  }
  lines.push("];", "");
  return lines.join("\n");
}

async function loadEmojiData(): Promise<EmojiDataEntry[]> {
  if (!existsSync(EMOJI_DATA_CACHE)) {
    console.log(`Fetching emoji data from ${EMOJI_DATA_URL}`);
    const res = await fetch(EMOJI_DATA_URL);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch emoji data: ${res.status} ${res.statusText}`,
      );
    }
    mkdirSync(dirname(EMOJI_DATA_CACHE), { recursive: true });
    writeFileSync(EMOJI_DATA_CACHE, await res.text());
  }
  return JSON.parse(readFileSync(EMOJI_DATA_CACHE, "utf8")) as EmojiDataEntry[];
}

async function main(): Promise<void> {
  const rows = buildTable(await loadEmojiData());
  writeFileSync(TS_OUT, emitTS(rows));
  // The daemon's pinned prettier, so the output passes the pre-commit check.
  const prettier = Bun.spawnSync(
    [
      resolve(REPO_ROOT, "assistant/node_modules/.bin/prettier"),
      "--write",
      TS_OUT,
    ],
    { stdout: "ignore", stderr: "inherit", windowsHide: true },
  );
  if (prettier.exitCode !== 0) {
    throw new Error(`prettier exited ${prettier.exitCode}`);
  }
  console.log(`Wrote ${rows.length} rows to:\n  ${TS_OUT}`);
}

main();
