#!/usr/bin/env bun

import { parseCliInput, printError, printJson } from "./lib/common.js";

export interface ThemeExtractInput {
  bio?: string;
  query?: string;
}

const THEME_KEYWORDS: Record<string, string[]> = {
  fashion: ["fashion", "style", "ootd", "designer", "wardrobe"],
  beauty: ["beauty", "makeup", "skincare", "cosmetic", "hair"],
  fitness: ["fitness", "gym", "workout", "athlete", "training"],
  food: ["food", "recipe", "chef", "restaurant", "foodie", "cooking"],
  travel: ["travel", "trip", "wanderlust", "destination", "adventure"],
  tech: ["tech", "software", "developer", "ai", "gadgets", "coding"],
  gaming: ["gaming", "gamer", "stream", "esports", "twitch"],
  music: ["music", "singer", "producer", "dj", "artist"],
  lifestyle: ["lifestyle", "daily", "vlog", "family", "wellness"],
  business: ["business", "startup", "founder", "entrepreneur", "marketing"],
};

export function extractThemes(bio: string, query: string): string[] {
  const source = `${bio} ${query}`.toLowerCase();
  const themes: string[] = [];

  for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
    if (keywords.some((keyword) => source.includes(keyword))) {
      themes.push(theme);
    }
  }

  return themes;
}

async function main(): Promise<void> {
  try {
    const { args, payload } = await parseCliInput<ThemeExtractInput>(
      process.argv.slice(2),
      {},
    );

    const bio = (typeof args.bio === "string" ? args.bio : undefined) ?? payload.bio ?? "";
    const query =
      (typeof args.query === "string" ? args.query : undefined) ?? payload.query ?? "";

    const data = extractThemes(bio, query);
    printJson({ ok: true, data });
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  await main();
}
