import { describe, expect, test } from "bun:test";

import { PRECHAT_TOOLS, stripOtherPrefix } from "@/lib/onboarding/prechat-tools.js";

describe("PRECHAT_TOOLS", () => {
  test("has 12 entries", () => {
    expect(PRECHAT_TOOLS.length).toBe(12);
  });

  test("every entry has a non-empty id and label", () => {
    for (const tool of PRECHAT_TOOLS) {
      expect(tool.id.length).toBeGreaterThan(0);
      expect(tool.label.length).toBeGreaterThan(0);
    }
  });
});

describe("stripOtherPrefix", () => {
  test("strips the 'other:' prefix from a single id", () => {
    expect(stripOtherPrefix(["other:Trello"])).toEqual(["Trello"]);
  });

  test("dedupes and returns a sorted list", () => {
    expect(stripOtherPrefix(["other:Trello", "other:Trello", "slack"])).toEqual(
      ["Trello", "slack"],
    );
  });

  test("returns ascending sorted output", () => {
    expect(
      stripOtherPrefix(["other:Zulip", "slack", "other:Asana", "gmail"]),
    ).toEqual(["Asana", "Zulip", "gmail", "slack"]);
  });

  test("returns an empty array when given an empty array", () => {
    expect(stripOtherPrefix([])).toEqual([]);
  });

  test("leaves ids without the prefix unchanged", () => {
    expect(stripOtherPrefix(["slack", "gmail"])).toEqual(["gmail", "slack"]);
  });
});
