import { describe, expect, test } from "bun:test";

import {
  buildEntityNameCatalog,
  EMPTY_ENTITY_NAME_CATALOG,
  findEntityNameMatches,
  lookupEntityName,
  MIN_ENTITY_NAME_LENGTH,
} from "@/domains/chat/utils/entity-name-links";

describe("buildEntityNameCatalog", () => {
  test("keeps unique conversation titles and schedule names", () => {
    const catalog = buildEntityNameCatalog({
      conversations: [
        { conversationId: "conv-xyz", title: "Project Launch" },
        { conversationId: "conv-abc", title: "Notes" },
      ],
      schedules: [{ id: "schedule-1", name: "Morning Briefing" }],
    });

    expect(catalog.byName.get("Project Launch")).toEqual({
      kind: "conversation",
      id: "conv-xyz",
      name: "Project Launch",
    });
    expect(catalog.byName.get("Morning Briefing")).toEqual({
      kind: "schedule",
      id: "schedule-1",
      name: "Morning Briefing",
    });
    expect(catalog.names[0]).toBe("Morning Briefing");
    expect(catalog.byName.get("Notes")).toEqual({
      kind: "conversation",
      id: "conv-abc",
      name: "Notes",
    });
  });

  test("drops colliding names, including across kinds", () => {
    const catalog = buildEntityNameCatalog({
      conversations: [
        { conversationId: "conv-1", title: "Weekly Sync" },
        { conversationId: "conv-2", title: "Weekly Sync" },
        { conversationId: "conv-3", title: "Morning Briefing" },
      ],
      schedules: [{ id: "schedule-1", name: "Morning Briefing" }],
    });

    expect(catalog.byName.has("Weekly Sync")).toBe(false);
    expect(catalog.byName.has("Morning Briefing")).toBe(false);
    expect(catalog.names).toEqual([]);
  });

  test("drops names shorter than the minimum length", () => {
    const catalog = buildEntityNameCatalog({
      conversations: [{ conversationId: "conv-xyz", title: "Q3" }],
      schedules: [{ id: "schedule-1", name: "AM" }],
    });

    expect("Q3".length).toBeLessThan(MIN_ENTITY_NAME_LENGTH);
    expect(catalog.names).toEqual([]);
  });

  test("trims whitespace before uniqueness", () => {
    const catalog = buildEntityNameCatalog({
      conversations: [
        { conversationId: "conv-xyz", title: "  Project Launch  " },
      ],
      schedules: [],
    });

    expect(catalog.byName.get("Project Launch")?.id).toBe("conv-xyz");
  });
});

describe("findEntityNameMatches", () => {
  const catalog = buildEntityNameCatalog({
    conversations: [{ conversationId: "conv-xyz", title: "Project Launch" }],
    schedules: [
      { id: "schedule-1", name: "Morning Briefing" },
      { id: "schedule-2", name: "Brief" },
    ],
  });

  test("matches exact unique names on unicode word boundaries", () => {
    expect(
      findEntityNameMatches(
        'I set up the Morning Briefing schedule and opened "Project Launch".',
        catalog,
      ),
    ).toEqual([
      { start: 13, end: 29, name: "Morning Briefing" },
      { start: 51, end: 65, name: "Project Launch" },
    ]);
  });

  test("prefers the longer unique name at the same index", () => {
    // "Brief" is unique too, but "Morning Briefing" is longer and wins.
    expect(findEntityNameMatches("Morning Briefing is ready", catalog)).toEqual([
      { start: 0, end: 16, name: "Morning Briefing" },
    ]);
  });

  test("does not match a name inside a longer word", () => {
    const briefOnly = buildEntityNameCatalog({
      conversations: [],
      schedules: [{ id: "schedule-2", name: "Brief" }],
    });
    expect(findEntityNameMatches("Morning Briefing", briefOnly)).toEqual([]);
    expect(findEntityNameMatches("the Brief is done", briefOnly)).toEqual([
      { start: 4, end: 9, name: "Brief" },
    ]);
  });

  test("returns nothing for an empty catalog", () => {
    expect(
      findEntityNameMatches("Morning Briefing", EMPTY_ENTITY_NAME_CATALOG),
    ).toEqual([]);
  });
});

describe("lookupEntityName", () => {
  const catalog = buildEntityNameCatalog({
    conversations: [],
    schedules: [{ id: "schedule-1", name: "Morning Briefing" }],
  });

  test("matches the whole string and a trimmed variant", () => {
    expect(lookupEntityName("Morning Briefing", catalog)?.id).toBe(
      "schedule-1",
    );
    expect(lookupEntityName("  Morning Briefing  ", catalog)?.id).toBe(
      "schedule-1",
    );
    expect(lookupEntityName("Morning", catalog)).toBeUndefined();
  });
});
