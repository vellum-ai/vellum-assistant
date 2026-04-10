#!/usr/bin/env bun

import { parseCliInput, parseFollowerCount, printError, printJson } from "./lib/common.js";
import { extractThemes } from "./influencer-theme-extract.js";

export type InfluencerPlatform = "instagram" | "tiktok" | "twitter";

export interface InfluencerProfile {
  platform: InfluencerPlatform;
  username: string;
  displayName?: string;
  profileUrl?: string;
  bio?: string;
  followers?: number;
  followersDisplay?: string;
  isVerified?: boolean;
  contentThemes?: string[];
}

export interface InfluencerCriteria {
  query?: string;
  minFollowers?: number;
  maxFollowers?: number;
  verifiedOnly?: boolean;
}

export interface ScoredProfile {
  profile: InfluencerProfile;
  score: number;
  matchesCriteria: boolean;
  reasons: string[];
}

export interface ScoreInput {
  profile?: InfluencerProfile;
  profiles?: InfluencerProfile[];
  criteria?: InfluencerCriteria;
}

function normalizeProfile(profile: InfluencerProfile, query: string): InfluencerProfile {
  const followers =
    profile.followers ??
    (profile.followersDisplay ? parseFollowerCount(profile.followersDisplay) : undefined);

  const bio = profile.bio ?? "";
  const themes = profile.contentThemes ?? extractThemes(bio, query);

  return {
    ...profile,
    followers,
    contentThemes: themes,
    bio,
    displayName: profile.displayName ?? profile.username,
  };
}

export function matchesCriteria(
  profile: InfluencerProfile,
  criteria: InfluencerCriteria,
): boolean {
  if (criteria.verifiedOnly && !profile.isVerified) return false;

  if (criteria.minFollowers !== undefined && profile.followers !== undefined) {
    if (profile.followers < criteria.minFollowers) return false;
  }

  if (criteria.maxFollowers !== undefined && profile.followers !== undefined) {
    if (profile.followers > criteria.maxFollowers) return false;
  }

  return true;
}

export function scoreProfile(
  profileInput: InfluencerProfile,
  criteria: InfluencerCriteria,
): ScoredProfile {
  const query = criteria.query ?? "";
  const profile = normalizeProfile(profileInput, query);

  const reasons: string[] = [];
  let score = 0;

  if (profile.followers !== undefined) {
    if (profile.followers >= 1_000) score += 10;
    if (profile.followers >= 10_000) score += 15;
    if (profile.followers >= 100_000) score += 20;
    if (profile.followers >= 1_000_000) score += 15;
    reasons.push(`followers:${profile.followers}`);
  } else {
    reasons.push("followers:unknown");
  }

  if (profile.isVerified) {
    score += 10;
    reasons.push("verified");
  }

  const bioLower = (profile.bio ?? "").toLowerCase();
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);

  let termHits = 0;
  for (const term of queryTerms) {
    if (bioLower.includes(term)) {
      termHits += 1;
      score += 8;
    }
  }
  if (termHits > 0) reasons.push(`query_hits:${termHits}`);

  if ((profile.contentThemes?.length ?? 0) > 0) {
    score += Math.min(20, (profile.contentThemes?.length ?? 0) * 4);
    reasons.push(`themes:${(profile.contentThemes ?? []).join(",")}`);
  }

  const matches = matchesCriteria(profile, criteria);
  if (!matches) {
    reasons.push("criteria_mismatch");
    score -= 20;
  }

  return {
    profile,
    score,
    matchesCriteria: matches,
    reasons,
  };
}

export function scoreProfiles(
  profiles: InfluencerProfile[],
  criteria: InfluencerCriteria,
): ScoredProfile[] {
  return profiles
    .map((profile) => scoreProfile(profile, criteria))
    .sort((left, right) => right.score - left.score);
}

async function main(): Promise<void> {
  try {
    const { args, payload } = await parseCliInput<ScoreInput>(
      process.argv.slice(2),
      {},
    );

    const criteria: InfluencerCriteria = {
      ...(payload.criteria ?? {}),
      ...(typeof args.query === "string" ? { query: args.query } : {}),
      ...(typeof args["min-followers"] === "string"
        ? { minFollowers: Number.parseInt(args["min-followers"], 10) }
        : {}),
      ...(typeof args["max-followers"] === "string"
        ? { maxFollowers: Number.parseInt(args["max-followers"], 10) }
        : {}),
      ...(args["verified-only"] !== undefined
        ? { verifiedOnly: String(args["verified-only"]).toLowerCase() === "true" }
        : {}),
    };

    const profiles = payload.profiles ?? (payload.profile ? [payload.profile] : []);
    const scored = scoreProfiles(profiles, criteria);

    printJson({ ok: true, data: scored });
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  await main();
}
