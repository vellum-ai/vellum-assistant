/**
 * CLI command group: `assistant influencer`
 *
 * Research influencers on Instagram, TikTok, and X/Twitter via the Chrome extension relay.
 * All commands output JSON to stdout. Use --json for machine-readable output.
 */

import { Command } from "commander";

import {
  compareInfluencers,
  getInfluencerProfile,
  type InfluencerSearchCriteria,
  searchInfluencers,
} from "./client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function output(data: unknown, json: boolean): void {
  process.stdout.write(
    json ? JSON.stringify(data) + "\n" : JSON.stringify(data, null, 2) + "\n",
  );
}

function outputError(message: string, code = 1): void {
  output({ ok: false, error: message }, true);
  process.exitCode = code;
}

function getJson(cmd: Command): boolean {
  let c: Command | null = cmd;
  while (c) {
    if ((c.opts() as { json?: boolean }).json) return true;
    c = c.parent;
  }
  return false;
}

async function run(cmd: Command, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    output({ ok: true, ...(result as Record<string, unknown>) }, getJson(cmd));
  } catch (err) {
    outputError(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerInfluencerCommand(program: Command): void {
  const inf = program
    .command("influencer")
    .description(
      "Research influencers on Instagram, TikTok, and X/Twitter. " +
        "Uses the Chrome extension relay to browse each platform. " +
        "Requires the user to be logged in on each platform in Chrome.",
    )
    .option("--json", "Machine-readable JSON output");

  inf.addHelpText(
    "after",
    `
Researches influencers via the Chrome extension relay, which automates
browsing on each platform. The user must be logged into each target
platform (Instagram, TikTok, X/Twitter) in Chrome for the relay to work.

Supported platforms: instagram, tiktok, twitter (X).

Examples:
  $ assistant influencer search "fitness coach" --platforms instagram,tiktok
  $ assistant influencer profile natgeo --platform instagram
  $ assistant influencer compare instagram:nike twitter:nike tiktok:nike`,
  );

  // =========================================================================
  // search — search for influencers across platforms
  // =========================================================================
  inf
    .command("search")
    .description(
      "Search for influencers matching criteria across Instagram, TikTok, and X/Twitter",
    )
    .argument(
      "<query>",
      'Search query — niche, topic, or keywords (e.g. "fitness coach", "vegan food")',
    )
    .option(
      "--platforms <platforms>",
      "Comma-separated list of platforms to search (instagram,tiktok,twitter)",
      "instagram,tiktok,twitter",
    )
    .option(
      "--min-followers <n>",
      "Minimum follower count (e.g. 10000, 10k, 1m)",
    )
    .option(
      "--max-followers <n>",
      "Maximum follower count (e.g. 100000, 100k, 1m)",
    )
    .option("--limit <n>", "Max results per platform", "10")
    .option("--verified", "Only return verified accounts")
    .addHelpText(
      "after",
      `
Arguments:
  query   Search query — niche, topic, or keywords (e.g. "fitness coach")

--platforms filters which platforms to search. Defaults to all three:
instagram, tiktok, twitter. Provide a comma-separated list to narrow.

--min-followers and --max-followers accept human-friendly notation:
  10k = 10,000    1.5m = 1,500,000    100k = 100,000
Plain integers are also accepted (e.g. 50000).

--limit caps the number of results returned per platform (default: 10).
--verified restricts results to verified/blue-check accounts only.

Examples:
  $ assistant influencer search "vegan food" --min-followers 10k --max-followers 1m
  $ assistant influencer search "tech reviewer" --platforms tiktok --limit 5 --verified
  $ assistant influencer search "streetwear" --platforms instagram,twitter --min-followers 50k`,
    )
    .action(
      async (
        query: string,
        opts: {
          platforms: string;
          minFollowers?: string;
          maxFollowers?: string;
          limit: string;
          verified?: boolean;
        },
        cmd: Command,
      ) => {
        await run(cmd, async () => {
          const platforms = opts.platforms
            .split(",")
            .map((p) => p.trim().toLowerCase())
            .filter((p): p is "instagram" | "tiktok" | "twitter" =>
              ["instagram", "tiktok", "twitter"].includes(p),
            );

          const criteria: InfluencerSearchCriteria = {
            query,
            platforms,
            minFollowers: opts.minFollowers
              ? parseHumanNumber(opts.minFollowers)
              : undefined,
            maxFollowers: opts.maxFollowers
              ? parseHumanNumber(opts.maxFollowers)
              : undefined,
            limit: parseInt(opts.limit, 10),
            verifiedOnly: opts.verified,
          };

          const results = await searchInfluencers(criteria);

          const totalProfiles = results.reduce((sum, r) => sum + r.count, 0);

          return {
            results,
            totalProfiles,
            platforms: platforms.length,
            query,
          };
        });
      },
    );

  // =========================================================================
  // profile — get detailed profile data for a specific influencer
  // =========================================================================
  inf
    .command("profile")
    .description("Get detailed profile data for a specific influencer")
    .argument("<username>", "Username/handle (without @ prefix)")
    .option(
      "--platform <platform>",
      "Platform (instagram, tiktok, or twitter)",
      "instagram",
    )
    .addHelpText(
      "after",
      `
Arguments:
  username   The influencer's handle without the @ prefix (e.g. "natgeo", not "@natgeo")

--platform selects which platform to look up. Defaults to instagram.
Valid values: instagram, tiktok, twitter.

Returns detailed profile data including follower count, bio, engagement
metrics, and recent post statistics.

Examples:
  $ assistant influencer profile natgeo --platform instagram
  $ assistant influencer profile charlidamelio --platform tiktok
  $ assistant influencer profile elonmusk --platform twitter`,
    )
    .action(
      async (username: string, opts: { platform: string }, cmd: Command) => {
        await run(cmd, async () => {
          const platform = opts.platform.toLowerCase() as
            | "instagram"
            | "tiktok"
            | "twitter";
          if (!["instagram", "tiktok", "twitter"].includes(platform)) {
            throw new Error(
              `Invalid platform: ${opts.platform}. Use instagram, tiktok, or twitter.`,
            );
          }

          const cleanUsername = username.replace(/^@/, "");
          const profile = await getInfluencerProfile(platform, cleanUsername);

          if (!profile) {
            throw new Error(
              `Could not find profile @${cleanUsername} on ${platform}`,
            );
          }

          return { profile };
        });
      },
    );

  // =========================================================================
  // compare — compare multiple influencers side by side
  // =========================================================================
  inf
    .command("compare")
    .description(
      "Compare multiple influencers side by side. " +
        "Provide usernames as platform:username pairs.",
    )
    .argument(
      "<influencers...>",
      "Space-separated list of platform:username pairs (e.g. instagram:nike twitter:nike tiktok:nike)",
    )
    .addHelpText(
      "after",
      `
Arguments:
  influencers   Space-separated platform:username pairs (e.g. instagram:nike twitter:nike)

Each argument must be in platform:username format. Valid platforms:
instagram, tiktok, twitter. If no platform prefix is provided, defaults
to instagram.

Returns side-by-side profile data for all specified influencers,
useful for comparing follower counts, engagement rates, and content
metrics across platforms or between competing accounts.

Examples:
  $ assistant influencer compare instagram:nike twitter:nike tiktok:nike
  $ assistant influencer compare instagram:natgeo instagram:discoverearth
  $ assistant influencer compare tiktok:charlidamelio tiktok:addisonre`,
    )
    .action(async (influencers: string[], _opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const parsed = influencers.map((inf) => {
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

        const profiles = await compareInfluencers(parsed);

        return {
          profiles,
          count: profiles.length,
          requested: parsed.length,
        };
      });
    });
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
