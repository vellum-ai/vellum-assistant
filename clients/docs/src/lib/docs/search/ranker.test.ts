import { describe, expect, test } from "bun:test";

import { searchDocsIndex } from "@/lib/docs/search/ranker";
import type { DocsSearchIndexFile } from "@/lib/docs/search/types";

const BASE_INDEX: DocsSearchIndexFile = {
  version: 1,
  generatedAt: new Date().toISOString(),
  chunks: [
    {
      id: "/docs/getting-started#__page",
      route: "/docs/getting-started",
      url: "/docs/getting-started",
      pageTitle: "Getting Started",
      breadcrumb: "Docs / Getting Started",
      heading: "Getting Started",
      headingLevel: 1,
      sectionId: null,
      body: "Install Vellum quickly and run your first workflow.",
      keywords: ["installation", "quickstart"],
    },
    {
      id: "/docs/help/common-issues#oauth",
      route: "/docs/help/common-issues",
      url: "/docs/help/common-issues#oauth",
      pageTitle: "Common Issues",
      breadcrumb: "Docs / Help / Common Issues",
      heading: "OAuth connection failed",
      headingLevel: 2,
      sectionId: "oauth",
      body: "Fix OAuth and reconnect your Google Calendar integration.",
      keywords: ["oauth", "google", "calendar"],
    },
  ],
};

describe("searchDocsIndex", () => {
  test("supports prefix and fuzzy lexical matching", () => {
    const prefix = searchDocsIndex({
      query: "instal",
      index: BASE_INDEX,
      limit: 5,
    });

    expect(prefix[0]?.route).toBe("/docs/getting-started");

    const fuzzy = searchDocsIndex({
      query: "calender",
      index: BASE_INDEX,
      limit: 5,
    });

    expect(fuzzy[0]?.route).toBe("/docs/help/common-issues");
  });

  test("builds fuzzy-match snippets from the matched term, not the raw query token", () => {
    const index: DocsSearchIndexFile = {
      ...BASE_INDEX,
      chunks: [
        {
          ...BASE_INDEX.chunks[1]!,
          body: `${"Filler text that pads the beginning of the body well past the snippet window so a start-of-body fallback would miss the match. ".repeat(3)}Reconnect your Google Calendar integration to fix sync.`,
        },
      ],
    };

    const fuzzy = searchDocsIndex({
      query: "calender",
      index,
      limit: 5,
    });

    expect(fuzzy[0]?.snippet.toLowerCase()).toContain("calendar");
  });

  test("boosts title/heading matches over body-only matches", () => {
    const index: DocsSearchIndexFile = {
      ...BASE_INDEX,
      chunks: [
        {
          ...BASE_INDEX.chunks[0]!,
          id: "/docs/title-match#__page",
          route: "/docs/title-match",
          url: "/docs/title-match",
          pageTitle: "Permissions Guide",
          heading: "Permissions Guide",
          body: "General introduction.",
          keywords: ["permissions"],
        },
        {
          ...BASE_INDEX.chunks[1]!,
          id: "/docs/body-match#__page",
          route: "/docs/body-match",
          url: "/docs/body-match",
          pageTitle: "Help",
          heading: "Help",
          body: "This paragraph mentions permissions once.",
          keywords: [],
        },
      ],
    };

    const results = searchDocsIndex({
      query: "permissions",
      index,
      limit: 5,
    });

    expect(results[0]?.route).toBe("/docs/title-match");
  });
});
