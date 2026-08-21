import { describe, expect, test } from "bun:test";

import {
  extractFirecrawlCompatSearchResults,
  resolveProviderApiUrl,
  searchResultSnippet,
} from "../firecrawl-compat.js";

describe("resolveProviderApiUrl", () => {
  test("uses the default base when apiBase is empty", () => {
    expect(
      resolveProviderApiUrl("", "/v1/search", "https://api.fastcrw.com"),
    ).toBe("https://api.fastcrw.com/v1/search");
    expect(
      resolveProviderApiUrl(undefined, "/v1/scrape", "https://api.fastcrw.com"),
    ).toBe("https://api.fastcrw.com/v1/scrape");
  });

  test("strips trailing slashes from a custom base", () => {
    expect(
      resolveProviderApiUrl(
        "http://localhost:3000///",
        "/v1/search",
        "https://api.fastcrw.com",
      ),
    ).toBe("http://localhost:3000/v1/search");
  });
});

describe("extractFirecrawlCompatSearchResults", () => {
  test("reads grouped data.web", () => {
    expect(
      extractFirecrawlCompatSearchResults({
        data: { web: [{ title: "A", url: "https://a.test" }] },
      }),
    ).toEqual([{ title: "A", url: "https://a.test" }]);
  });

  test("reads data.results as a flat array", () => {
    expect(
      extractFirecrawlCompatSearchResults({
        data: { results: [{ title: "B", url: "https://b.test" }] },
      }),
    ).toEqual([{ title: "B", url: "https://b.test" }]);
  });

  test("reads self-hosted data.results.web when sources group by type", () => {
    expect(
      extractFirecrawlCompatSearchResults({
        data: {
          results: {
            web: [{ title: "Self-host", url: "https://local.test" }],
            news: [{ title: "News", url: "https://news.test" }],
          },
        },
      }),
    ).toEqual([{ title: "Self-host", url: "https://local.test" }]);
  });

  test("reads a flat data array", () => {
    expect(
      extractFirecrawlCompatSearchResults({
        data: [{ title: "C", url: "https://c.test" }],
      }),
    ).toEqual([{ title: "C", url: "https://c.test" }]);
  });
});

describe("searchResultSnippet", () => {
  test("prefers description then snippet", () => {
    expect(
      searchResultSnippet({ description: "desc", snippet: "snip" }),
    ).toBe("desc");
    expect(searchResultSnippet({ snippet: "snip" })).toBe("snip");
    expect(searchResultSnippet({})).toBeUndefined();
  });
});
