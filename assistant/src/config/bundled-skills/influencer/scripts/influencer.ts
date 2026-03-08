#!/usr/bin/env bun
import { parseArgs } from "node:util";

import {
  compareInfluencers,
  getInfluencerProfile,
  type InfluencerSearchCriteria,
  searchInfluencers,
} from "./client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isJson = process.argv.includes("--json");

function output(data: unknown): void {
  process.stdout.write(
    isJson ? JSON.stringify(data) + "\n" : JSON.stringify(data, null, 2) + "\n",
  );
}

function outputError(message: string, code = 1): void {
  output({ ok: false, error: message });
  process.exitCode = code;
}

async function run(fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    output({ ok: true, ...(result as Record<string, unknown>) });
  } catch (err) {
    outputError(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Parse human-friendly numbers like "10k", "1.5m", "100000" into integers.
 */
function parseHumanNumber(text: string): number {
  const cleaned = text.toLowerCase().replace(/,/g, "").trim();
  const match = cleaned.match(/^([\d.]+)\s*([kmbt]?)$/);
  if (!match) return parseInt(text, 10) || 0;

  const num = parseFloat(match[1]);
  const suffix = match[2];
  const multipliers: Record<string, number> = {
    "": 1,
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000,
    t: 1_000_000_000_000,
  };

  return Math.round(num * (multipliers[suffix] || 1));
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const USAGE = `influencer — Research influencers on Instagram, TikTok, and X/Twitter

Uses the Chrome extension relay to browse each platform. Requires the user to
be logged in on each platform in Chrome.

USAGE
  influencer <subcommand> [options]

SUBCOMMANDS
  search <query>                Search for influencers matching criteria
  profile <username>            Get detailed profile data for one influencer
  compare <platform:user ...>   Compare multiple influencers side by side

GLOBAL OPTIONS
  --json        Machine-readable JSON output (compact, one line)
  --help, -h    Show this help message

SEARCH OPTIONS
  --platforms <list>       Comma-separated platforms (default: instagram,tiktok,twitter)
  --min-followers <n>      Minimum follower count (e.g. 10k, 1.5m, 50000)
  --max-followers <n>      Maximum follower count
  --limit <n>              Max results per platform (default: 10)
  --verified               Only return verified accounts

PROFILE OPTIONS
  --platform <name>        Platform to look up (default: instagram)

EXAMPLES
  influencer search "fitness coach" --platforms instagram,tiktok
  influencer search "vegan food" --min-followers 10k --max-followers 1m --json
  influencer profile natgeo --platform instagram
  influencer compare instagram:nike twitter:nike tiktok:nike
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Subcommand routing
// ---------------------------------------------------------------------------

const subcommand = process.argv[2];

switch (subcommand) {
  case "search": {
    // Strip the subcommand and --json from argv for parseArgs
    const filteredArgs = process.argv.slice(3).filter((a) => a !== "--json");

    const { values, positionals } = parseArgs({
      args: filteredArgs,
      options: {
        platforms: { type: "string", default: "instagram,tiktok,twitter" },
        "min-followers": { type: "string" },
        "max-followers": { type: "string" },
        limit: { type: "string", default: "10" },
        verified: { type: "boolean", default: false },
      },
      allowPositionals: true,
    });

    const query = positionals[0];
    if (!query) {
      outputError("Missing required argument: <query>");
      break;
    }

    const platforms = (values.platforms as string)
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter((p): p is "instagram" | "tiktok" | "twitter" =>
        ["instagram", "tiktok", "twitter"].includes(p),
      );

    const criteria: InfluencerSearchCriteria = {
      query,
      platforms,
      minFollowers: values["min-followers"]
        ? parseHumanNumber(values["min-followers"] as string)
        : undefined,
      maxFollowers: values["max-followers"]
        ? parseHumanNumber(values["max-followers"] as string)
        : undefined,
      limit: parseInt(values.limit as string, 10),
      verifiedOnly: values.verified as boolean,
    };

    await run(async () => {
      const results = await searchInfluencers(criteria);
      const totalProfiles = results.reduce((sum, r) => sum + r.count, 0);
      return {
        results,
        totalProfiles,
        platforms: platforms.length,
        query,
      };
    });

    break;
  }

  case "profile": {
    const filteredArgs = process.argv.slice(3).filter((a) => a !== "--json");

    const { values, positionals } = parseArgs({
      args: filteredArgs,
      options: {
        platform: { type: "string", default: "instagram" },
      },
      allowPositionals: true,
    });

    const username = positionals[0];
    if (!username) {
      outputError("Missing required argument: <username>");
      break;
    }

    const platform = (values.platform as string).toLowerCase() as
      | "instagram"
      | "tiktok"
      | "twitter";
    if (!["instagram", "tiktok", "twitter"].includes(platform)) {
      outputError(
        `Invalid platform: ${values.platform}. Use instagram, tiktok, or twitter.`,
      );
      break;
    }

    const cleanUsername = username.replace(/^@/, "");

    await run(async () => {
      const profile = await getInfluencerProfile(platform, cleanUsername);
      if (!profile) {
        throw new Error(
          `Could not find profile @${cleanUsername} on ${platform}`,
        );
      }
      return { profile };
    });

    break;
  }

  case "compare": {
    const filteredArgs = process.argv.slice(3).filter((a) => a !== "--json");

    const { positionals } = parseArgs({
      args: filteredArgs,
      options: {},
      allowPositionals: true,
    });

    if (positionals.length === 0) {
      outputError("Missing required arguments: <platform:username ...>");
      break;
    }

    const parsed = positionals.map((inf) => {
      const [platform, username] = inf.includes(":")
        ? inf.split(":", 2)
        : ["instagram", inf];

      const cleanPlatform = platform.toLowerCase() as
        | "instagram"
        | "tiktok"
        | "twitter";
      if (!["instagram", "tiktok", "twitter"].includes(cleanPlatform)) {
        throw new Error(
          `Invalid platform "${platform}" in "${inf}". Use instagram, tiktok, or twitter.`,
        );
      }

      return {
        platform: cleanPlatform,
        username: username.replace(/^@/, ""),
      };
    });

    await run(async () => {
      const profiles = await compareInfluencers(parsed);
      return {
        profiles,
        count: profiles.length,
        requested: parsed.length,
      };
    });

    break;
  }

  default: {
    process.stderr.write(
      subcommand
        ? `Unknown subcommand: ${subcommand}\n\n`
        : "No subcommand provided.\n\n",
    );
    process.stderr.write(USAGE);
    process.exitCode = 1;
  }
}
