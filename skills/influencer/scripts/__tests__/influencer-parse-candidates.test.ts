import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseCandidates } from "../influencer-parse-candidates.js";

const INSTAGRAM_FIXTURE = readFileSync(
  new URL("../__fixtures__/instagram-sample.txt", import.meta.url),
  "utf8",
);

const TWITTER_FIXTURE = readFileSync(
  new URL("../__fixtures__/twitter-sample.txt", import.meta.url),
  "utf8",
);

describe("parseCandidates", () => {
  test("parses instagram handles from text and links", () => {
    const profiles = parseCandidates({
      platform: "instagram",
      text: INSTAGRAM_FIXTURE,
      links: ["https://www.instagram.com/fit_with_amy/"],
    });

    expect(profiles.some((profile) => profile.username === "fit_with_amy")).toBe(true);
    expect(profiles.some((profile) => profile.username === "coach.jay")).toBe(true);
  });

  test("parses twitter handles from user-cell style text", () => {
    const profiles = parseCandidates({
      platform: "twitter",
      text: TWITTER_FIXTURE,
    });

    expect(profiles).toHaveLength(1);
    expect(profiles[0].username).toBe("alexfit");
    expect(profiles[0].displayName).toBe("Alex Rivera");
  });
});
