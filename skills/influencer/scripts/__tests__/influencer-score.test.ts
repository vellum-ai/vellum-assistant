import { describe, expect, test } from "bun:test";

import { scoreProfile } from "../influencer-score.js";

describe("scoreProfile", () => {
  test("scores verified profile with strong follower count higher", () => {
    const scored = scoreProfile(
      {
        platform: "instagram",
        username: "coachmax",
        bio: "Fitness and wellness creator",
        followersDisplay: "250K",
        isVerified: true,
      },
      {
        query: "fitness wellness",
        minFollowers: 10_000,
      },
    );

    expect(scored.matchesCriteria).toBe(true);
    expect(scored.score).toBeGreaterThan(30);
    expect(scored.reasons).toContain("verified");
  });

  test("marks mismatch when profile violates verified-only criteria", () => {
    const scored = scoreProfile(
      {
        platform: "tiktok",
        username: "microcreator",
        followersDisplay: "12K",
        isVerified: false,
      },
      {
        verifiedOnly: true,
      },
    );

    expect(scored.matchesCriteria).toBe(false);
    expect(scored.reasons).toContain("criteria_mismatch");
  });
});
