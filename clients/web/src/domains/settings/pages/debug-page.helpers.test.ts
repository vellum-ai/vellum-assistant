import { describe, expect, test } from "bun:test";

import { resolveDebugTabParam } from "@/domains/settings/pages/debug-page.helpers";

describe("resolveDebugTabParam", () => {
  test("opens the Conversations tab pre-filtered for legacy ?tab=archive", () => {
    // The assistant's navigate_settings_tab still emits the "Archive" tab name,
    // and old bookmarks carry ?tab=archive.
    expect(resolveDebugTabParam("archive")).toEqual({
      tabId: "conversations",
      conversationsFilter: "archived",
    });
  });

  test("opens the Conversations tab unfiltered", () => {
    expect(resolveDebugTabParam("conversations")).toEqual({
      tabId: "conversations",
      conversationsFilter: "all",
    });
  });

  test("passes other tabs through untouched", () => {
    expect(resolveDebugTabParam("doctor")).toEqual({
      tabId: "doctor",
      conversationsFilter: "all",
    });
    expect(resolveDebugTabParam(null)).toEqual({
      tabId: null,
      conversationsFilter: "all",
    });
  });
});
