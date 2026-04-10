import { describe, expect, test } from "bun:test";

import { classifyInfluencerIntent } from "../influencer-intent.js";

describe("classifyInfluencerIntent", () => {
  test("defaults to discover", () => {
    const result = classifyInfluencerIntent({
      request: "find tech creators on instagram",
    });

    expect(result.step).toBe("discover");
  });

  test("routes to enrich_profile for profile-oriented request", () => {
    const result = classifyInfluencerIntent({
      request: "tell me more about @creator",
    });

    expect(result.step).toBe("enrich_profile");
  });

  test("routes to compare when shortlist exists", () => {
    const result = classifyInfluencerIntent({
      request: "compare the top picks",
      context: { hasCandidates: true },
    });

    expect(result.step).toBe("compare_shortlist");
  });
});
