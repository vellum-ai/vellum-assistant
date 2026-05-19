import { describe, expect, test } from "bun:test";

import type { GlobalSearchResponse } from "@/domains/chat/lib/global-search.js";

import { buildServerResultSections } from "@/domains/chat/hooks/use-command-palette-sections.js";

const searchResults: GlobalSearchResponse = {
  conversations: [
    { id: "c1", title: "Alpha", updatedAt: 1, excerpt: "snippet-a", matchCount: 1 },
    { id: "c2", title: "Beta", updatedAt: 2, excerpt: "snippet-b", matchCount: 1 },
    { id: "c3", title: null, updatedAt: 3, excerpt: "snippet-c", matchCount: 1 },
  ],
  schedules: [
    { id: "s1", name: "Daily Digest", cronExpression: "0 9 * * *", nextRunAt: null, enabled: true },
  ],
  contacts: [
    { id: "ct1", name: "Alice", email: "alice@example.com" },
    { id: "ct2", name: "Bob", phone: "+1234567890" },
  ],
};

describe("buildServerResultSections", () => {
  test("builds all three section types from server results", () => {
    const sections = buildServerResultSections(searchResults, new Set());
    expect(sections).toHaveLength(3);
    expect(sections[0]!.id).toBe("search-conversations");
    expect(sections[0]!.items).toHaveLength(3);
    expect(sections[1]!.id).toBe("search-schedules");
    expect(sections[1]!.items).toHaveLength(1);
    expect(sections[2]!.id).toBe("search-contacts");
    expect(sections[2]!.items).toHaveLength(2);
  });

  test("deduplicates conversations already in local recents", () => {
    const recentKeys = new Set(["c1", "c3"]);
    const sections = buildServerResultSections(searchResults, recentKeys);
    const convSection = sections.find((s) => s.id === "search-conversations");
    expect(convSection!.items).toHaveLength(1);
    expect(convSection!.items[0]!.id).toBe("search-conv-c2");
  });

  test("omits empty sections entirely", () => {
    const emptyResults: GlobalSearchResponse = {
      conversations: [],
      schedules: [],
      contacts: [{ id: "ct1", name: "Solo", email: "solo@example.com" }],
    };
    const sections = buildServerResultSections(emptyResults, new Set());
    expect(sections).toHaveLength(1);
    expect(sections[0]!.id).toBe("search-contacts");
  });

  test("uses 'Untitled' for null conversation titles", () => {
    const sections = buildServerResultSections(searchResults, new Set());
    const convSection = sections.find((s) => s.id === "search-conversations")!;
    const nullTitleItem = convSection.items.find((i) => i.id === "search-conv-c3");
    expect(nullTitleItem!.title).toBe("Untitled");
  });

  test("prefers email over phone for contact subtitle", () => {
    const sections = buildServerResultSections(searchResults, new Set());
    const contactSection = sections.find((s) => s.id === "search-contacts")!;
    expect(contactSection.items[0]!.subtitle).toBe("alice@example.com");
    expect(contactSection.items[1]!.subtitle).toBe("+1234567890");
  });

  test("returns empty array when all results are empty", () => {
    const emptyResults: GlobalSearchResponse = {
      conversations: [],
      schedules: [],
      contacts: [],
    };
    const sections = buildServerResultSections(emptyResults, new Set());
    expect(sections).toHaveLength(0);
  });

  test("drops conversations section when all are duplicates", () => {
    const allDuplicates = new Set(["c1", "c2", "c3"]);
    const sections = buildServerResultSections(searchResults, allDuplicates);
    expect(sections.find((s) => s.id === "search-conversations")).toBeUndefined();
    expect(sections).toHaveLength(2);
  });
});
