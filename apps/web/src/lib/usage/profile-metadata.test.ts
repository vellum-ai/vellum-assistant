import { describe, expect, test } from "bun:test";

import { extractUsageProfileMetadata } from "@/lib/usage/profile-metadata.js";

describe("extractUsageProfileMetadata", () => {
  test("uses a non-empty profile label as the display name", () => {
    expect(
      extractUsageProfileMetadata({
        llm: {
          profiles: {
            quality: {
              label: "Quality",
            },
          },
        },
      }),
    ).toEqual({
      quality: {
        id: "quality",
        displayName: "Quality",
      },
    });
  });

  test("falls back to the profile ID when label is missing", () => {
    expect(
      extractUsageProfileMetadata({
        llm: {
          profiles: {
            fast: {},
          },
        },
      }),
    ).toEqual({
      fast: {
        id: "fast",
        displayName: "fast",
      },
    });
  });

  test("preserves a non-empty profile description", () => {
    expect(
      extractUsageProfileMetadata({
        llm: {
          profiles: {
            quality: {
              label: "Quality",
              description: "Higher quality responses.",
            },
          },
        },
      }),
    ).toEqual({
      quality: {
        id: "quality",
        displayName: "Quality",
        description: "Higher quality responses.",
      },
    });
  });

  test("returns an empty map for missing or malformed profiles", () => {
    expect(extractUsageProfileMetadata({})).toEqual({});
    expect(extractUsageProfileMetadata({ llm: {} })).toEqual({});
    expect(
      extractUsageProfileMetadata({
        llm: {
          profiles: null,
        },
      }),
    ).toEqual({});
    expect(
      extractUsageProfileMetadata({
        llm: {
          profiles: {
            quality: null,
            fast: "fast",
          },
        },
      }),
    ).toEqual({});
  });
});
