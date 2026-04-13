import { describe, expect, test } from "bun:test";

import { compareInfluencers } from "../influencer-compare.js";

describe("compareInfluencers", () => {
  test("returns sorted shortlist filtered by criteria", () => {
    const compared = compareInfluencers({
      profiles: [
        {
          platform: "instagram",
          username: "creator_a",
          bio: "fitness coach",
          followersDisplay: "120K",
          isVerified: true,
        },
        {
          platform: "tiktok",
          username: "creator_b",
          bio: "fitness clips",
          followersDisplay: "20K",
          isVerified: false,
        },
      ],
      criteria: {
        query: "fitness",
        minFollowers: 10_000,
      },
      limit: 1,
    });

    expect(compared).toHaveLength(1);
    expect(compared[0].username).toBe("creator_a");
  });
});
