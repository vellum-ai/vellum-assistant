#!/usr/bin/env bun

import { parseCliInput, printError, printJson } from "./lib/common.js";
import {
  type InfluencerCriteria,
  type InfluencerProfile,
  scoreProfiles,
} from "./influencer-score.js";

export interface CompareInput {
  profiles?: InfluencerProfile[];
  criteria?: InfluencerCriteria;
  limit?: number;
}

export interface ComparedInfluencer {
  platform: string;
  username: string;
  displayName: string;
  followers?: number;
  followersDisplay?: string;
  verified: boolean;
  score: number;
  highlights: string[];
  profileUrl?: string;
}

export function compareInfluencers(input: CompareInput): ComparedInfluencer[] {
  const profiles = input.profiles ?? [];
  const criteria = input.criteria ?? {};
  const limit = Math.max(1, input.limit ?? 10);

  return scoreProfiles(profiles, criteria)
    .filter((entry) => entry.matchesCriteria)
    .slice(0, limit)
    .map((entry) => ({
      platform: entry.profile.platform,
      username: entry.profile.username,
      displayName: entry.profile.displayName ?? entry.profile.username,
      followers: entry.profile.followers,
      followersDisplay:
        entry.profile.followersDisplay ??
        (entry.profile.followers !== undefined ? `${entry.profile.followers}` : undefined),
      verified: Boolean(entry.profile.isVerified),
      score: entry.score,
      highlights: entry.reasons,
      profileUrl: entry.profile.profileUrl,
    }));
}

async function main(): Promise<void> {
  try {
    const { args, payload } = await parseCliInput<CompareInput>(
      process.argv.slice(2),
      {},
    );

    const limit =
      (typeof args.limit === "string" ? Number.parseInt(args.limit, 10) : undefined) ??
      payload.limit;

    const data = compareInfluencers({
      ...payload,
      limit,
    });

    printJson({ ok: true, data });
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  await main();
}
