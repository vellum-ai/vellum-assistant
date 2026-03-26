import { describe, expect, test } from "bun:test";

import { filterByQuery } from "../skills/catalog-search.js";

interface FakeSkill {
  id: string;
  name: string;
  description: string;
}

const skills: FakeSkill[] = [
  {
    id: "weather",
    name: "Weather Lookup",
    description: "Get current weather for a city",
  },
  {
    id: "search",
    name: "Web Search",
    description: "Search the web for information",
  },
  {
    id: "deploy",
    name: "Deploy Helper",
    description: "Deploy apps to production",
  },
];

const fields: ((s: FakeSkill) => string)[] = [
  (s) => s.id,
  (s) => s.name,
  (s) => s.description,
];

describe("filterByQuery", () => {
  test("case-insensitive matching", () => {
    const result = filterByQuery(skills, "WEATHER", fields);
    expect(result).toEqual([skills[0]]);
  });

  test("matches on any supplied field accessor", () => {
    // Match on id
    expect(filterByQuery(skills, "deploy", fields)).toEqual([skills[2]]);
    // Match on name
    expect(filterByQuery(skills, "Web Search", fields)).toEqual([skills[1]]);
    // Match on description
    expect(filterByQuery(skills, "production", fields)).toEqual([skills[2]]);
  });

  test("returns empty array for no matches", () => {
    const result = filterByQuery(skills, "nonexistent", fields);
    expect(result).toEqual([]);
  });

  test("returns all items for broad query", () => {
    // All skills have "e" somewhere in their fields
    const result = filterByQuery(skills, "e", fields);
    expect(result).toHaveLength(3);
    expect(result).toEqual(skills);
  });
});
