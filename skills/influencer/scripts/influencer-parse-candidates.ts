#!/usr/bin/env bun

import {
  normalizeWhitespace,
  parseCliInput,
  parseFollowerCount,
  printError,
  printJson,
  safeStringArray,
  toLines,
} from "./lib/common.js";
import type { InfluencerPlatform, InfluencerProfile } from "./influencer-score.js";

export interface ParseCandidatesInput {
  platform?: InfluencerPlatform;
  text?: string;
  links?: string[];
  extracted?: {
    text?: string;
    links?: string[];
  };
}

function dedupeProfiles(profiles: InfluencerProfile[]): InfluencerProfile[] {
  const byKey = new Map<string, InfluencerProfile>();
  for (const profile of profiles) {
    const key = `${profile.platform}:${profile.username.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, profile);
      continue;
    }

    byKey.set(key, {
      ...existing,
      ...profile,
      bio: profile.bio ?? existing.bio,
      followers: profile.followers ?? existing.followers,
      followersDisplay: profile.followersDisplay ?? existing.followersDisplay,
      displayName: profile.displayName ?? existing.displayName,
      isVerified: profile.isVerified ?? existing.isVerified,
    });
  }
  return Array.from(byKey.values());
}

function parseInstagram(text: string, links: string[]): InfluencerProfile[] {
  const profiles: InfluencerProfile[] = [];

  const handleMatches = text.match(/@([a-zA-Z0-9._]{2,30})/g) ?? [];
  for (const match of handleMatches) {
    const username = match.slice(1);
    profiles.push({
      platform: "instagram",
      username,
      displayName: username,
      profileUrl: `https://www.instagram.com/${username}/`,
      followersDisplay: "unknown",
      isVerified: /verified/i.test(text),
    });
  }

  for (const link of links) {
    const profileMatch = link.match(/instagram\.com\/([a-zA-Z0-9._]{2,30})\/?/i);
    if (!profileMatch) continue;

    const username = profileMatch[1];
    if (["p", "reel", "explore", "stories"].includes(username.toLowerCase())) {
      continue;
    }

    profiles.push({
      platform: "instagram",
      username,
      displayName: username,
      profileUrl: `https://www.instagram.com/${username}/`,
      followersDisplay: "unknown",
      isVerified: false,
    });
  }

  return dedupeProfiles(profiles);
}

function parseTikTok(text: string): InfluencerProfile[] {
  const lines = toLines(text);
  const profiles: InfluencerProfile[] = [];

  for (let index = 0; index < lines.length - 3; index += 1) {
    const line = lines[index];
    const usernameMatch = line.match(/^@?([a-zA-Z0-9._]{2,24})$/);
    if (!usernameMatch) continue;

    const next = lines[index + 1]?.toLowerCase() ?? "";
    const nextTwo = lines[index + 2] ?? "";
    const nextThree = lines[index + 3] ?? "";

    if (!next.includes("follower") && !nextTwo.toLowerCase().includes("follower")) {
      continue;
    }

    const followersDisplay = next.includes("follower") ? line : nextTwo;
    const parsedFollowers = parseFollowerCount(`${next} ${nextTwo} ${nextThree}`);

    profiles.push({
      platform: "tiktok",
      username: usernameMatch[1].replace(/^@/, ""),
      displayName: lines[index - 1] ?? usernameMatch[1],
      profileUrl: `https://www.tiktok.com/@${usernameMatch[1].replace(/^@/, "")}`,
      followers: parsedFollowers,
      followersDisplay:
        parsedFollowers !== undefined ? `${parsedFollowers}` : normalizeWhitespace(followersDisplay),
      isVerified: /verified/i.test(lines.slice(Math.max(0, index - 2), index + 3).join(" ")),
    });
  }

  return dedupeProfiles(profiles);
}

function parseTwitter(text: string, links: string[]): InfluencerProfile[] {
  const profiles: InfluencerProfile[] = [];
  const lines = toLines(text);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const usernameMatch = line.match(/^@([a-zA-Z0-9_]{1,15})$/);
    if (!usernameMatch) continue;

    const username = usernameMatch[1];
    const displayName = lines[index - 1] && !lines[index - 1].startsWith("@")
      ? lines[index - 1]
      : username;

    profiles.push({
      platform: "twitter",
      username,
      displayName,
      profileUrl: `https://x.com/${username}`,
      followersDisplay: "unknown",
      isVerified: /verified/i.test(lines.slice(Math.max(0, index - 2), index + 3).join(" ")),
      bio: lines[index + 1],
    });
  }

  for (const link of links) {
    const match = link.match(/(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]{1,15})/i);
    if (!match) continue;

    const username = match[1];
    profiles.push({
      platform: "twitter",
      username,
      displayName: username,
      profileUrl: `https://x.com/${username}`,
      followersDisplay: "unknown",
      isVerified: false,
    });
  }

  return dedupeProfiles(profiles);
}

export function parseCandidates(input: ParseCandidatesInput): InfluencerProfile[] {
  const platform = input.platform ?? "instagram";
  const text = input.text ?? input.extracted?.text ?? "";
  const links = safeStringArray(input.links ?? input.extracted?.links ?? []);

  switch (platform) {
    case "instagram":
      return parseInstagram(text, links);
    case "tiktok":
      return parseTikTok(text);
    case "twitter":
      return parseTwitter(text, links);
    default:
      return [];
  }
}

async function main(): Promise<void> {
  try {
    const { args, payload } = await parseCliInput<ParseCandidatesInput>(
      process.argv.slice(2),
      {},
    );

    const platform =
      (typeof args.platform === "string" ? args.platform : undefined) ?? payload.platform;

    if (!platform || !["instagram", "tiktok", "twitter"].includes(platform)) {
      printError("platform must be one of instagram, tiktok, twitter");
      return;
    }

    const text = (typeof args.text === "string" ? args.text : undefined) ?? payload.text;
    const links =
      (typeof args.links === "string"
        ? args.links
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : payload.links) ?? [];

    const data = parseCandidates({
      ...payload,
      platform: platform as InfluencerPlatform,
      text,
      links,
    });

    printJson({ ok: true, data });
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  await main();
}
