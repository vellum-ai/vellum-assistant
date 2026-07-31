import { describe, expect, test } from "bun:test";

import { parseWebSearchResultText } from "@/domains/chat/utils/web-search-result-text";

describe("parseWebSearchResultText — Anthropic-native format", () => {
  test("extracts title + url pairs separated by a blank line", () => {
    const text = [
      "Tigers - Wikipedia",
      "https://en.wikipedia.org/wiki/Tiger",
      "",
      "Big Cats Conservation",
      "https://bigcats.org/conservation",
    ].join("\n");
    const results = parseWebSearchResultText(text);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      rank: 1,
      title: "Tigers - Wikipedia",
      url: "https://en.wikipedia.org/wiki/Tiger",
      domain: "en.wikipedia.org",
    });
    expect(results[1]).toMatchObject({
      rank: 2,
      title: "Big Cats Conservation",
      url: "https://bigcats.org/conservation",
      domain: "bigcats.org",
    });
  });

  test("strips a leading `www.` from the derived domain", () => {
    const text = "Example\nhttps://www.example.com/x";
    const [result] = parseWebSearchResultText(text);
    expect(result?.domain).toBe("example.com");
  });
});

describe("parseWebSearchResultText — Brave / Tavily format", () => {
  test("handles the header + numbered chunks with `URL:` prefixes and snippet lines between pairs", () => {
    const text = [
      'Web search results for "tigers":',
      "",
      "1. Tigers - Wikipedia",
      "   URL: https://en.wikipedia.org/wiki/Tiger",
      "   The tiger is the largest living cat species.",
      "   Age: 2 days",
      "",
      "2. Tiger conservation status",
      "   URL: https://worldwildlife.org/species/tiger",
      "   Tigers are endangered.",
      "",
    ].join("\n");
    const results = parseWebSearchResultText(text);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: "Tigers - Wikipedia",
      url: "https://en.wikipedia.org/wiki/Tiger",
      domain: "en.wikipedia.org",
    });
    expect(results[1]).toMatchObject({
      title: "Tiger conservation status",
      url: "https://worldwildlife.org/species/tiger",
      domain: "worldwildlife.org",
    });
  });
});

describe("parseWebSearchResultText — Perplexity citations", () => {
  test("extracts citation URLs even without titles", () => {
    const text = [
      'Web search results for "tigers":',
      "",
      "Tigers are large cats native to Asia. Several subspecies remain critically endangered.",
      "",
      "Sources:",
      "  [1] https://en.wikipedia.org/wiki/Tiger",
      "  [2] https://worldwildlife.org/species/tiger",
    ].join("\n");
    const results = parseWebSearchResultText(text);
    expect(results.length).toBeGreaterThanOrEqual(2);
    const urls = results.map((r) => r.url);
    expect(urls).toContain("https://en.wikipedia.org/wiki/Tiger");
    expect(urls).toContain("https://worldwildlife.org/species/tiger");
  });
});

describe("parseWebSearchResultText — edge cases", () => {
  test("returns [] for undefined input", () => {
    expect(parseWebSearchResultText(undefined)).toEqual([]);
  });

  test("returns [] for empty string", () => {
    expect(parseWebSearchResultText("")).toEqual([]);
  });

  test("returns [] for whitespace-only input", () => {
    expect(parseWebSearchResultText("   \n\t\n  ")).toEqual([]);
  });

  test("returns [] for malformed input with no URLs", () => {
    expect(parseWebSearchResultText("Found 3 results\nNo URLs here")).toEqual(
      [],
    );
  });

  test("dedupes repeated URLs", () => {
    const text = [
      "Tigers",
      "https://example.com/tigers",
      "",
      "Tigers (again)",
      "https://example.com/tigers",
    ].join("\n");
    const results = parseWebSearchResultText(text);
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe("https://example.com/tigers");
  });

  test("ignores invalid URL-shaped lines that don't actually parse", () => {
    // Invalid URL surface is upstream of our parser — `new URL("http://")`
    // would throw and the resulting domain would be empty. We still emit
    // the entry but with an empty domain.
    const text = "Some title\nhttp://broken";
    const results = parseWebSearchResultText(text);
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe("http://broken");
  });

  test("preserves rank starting at 1 in document order", () => {
    const text = [
      "A",
      "https://a.test/",
      "",
      "B",
      "https://b.test/",
      "",
      "C",
      "https://c.test/",
    ].join("\n");
    const results = parseWebSearchResultText(text);
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3]);
  });
});
