import { afterEach, describe, expect, test } from "bun:test";

import { useSidebarLayoutStore } from "@/domains/chat/sidebar-layout-store";
import { channelSectionKey } from "@/domains/chat/utils/sidebar-group-collapse-storage";

function resetStore() {
  useSidebarLayoutStore.setState({
    assistantId: null,
    openCategories: [],
    openCustomGroups: [],
    openPrimary: ["pinned", "recents"],
  });
}

afterEach(() => {
  resetStore();
  localStorage.clear();
});

describe("SidebarLayoutStore", () => {
  test("defaults to no open categories or custom groups", () => {
    const state = useSidebarLayoutStore.getState();
    expect(state.openCategories).toEqual([]);
    expect(state.openCustomGroups).toEqual([]);
    expect(state.assistantId).toBeNull();
  });

  test("setAssistantId hydrates from localStorage", () => {
    localStorage.setItem(
      "vellum:sidebar-open-categories:asst-1",
      JSON.stringify(["scheduled", "background"]),
    );
    localStorage.setItem(
      "vellum:sidebar-open-custom-groups:asst-1",
      JSON.stringify(["grp-abc"]),
    );

    useSidebarLayoutStore.getState().setAssistantId("asst-1");

    const state = useSidebarLayoutStore.getState();
    expect(state.assistantId).toBe("asst-1");
    expect(state.openCategories).toEqual(["scheduled", "background"]);
    expect(state.openCustomGroups).toEqual(["grp-abc"]);
  });

  test("setAssistantId no-ops when assistantId is unchanged", () => {
    useSidebarLayoutStore.getState().setAssistantId("asst-1");
    useSidebarLayoutStore.getState().setOpenCategories(["scheduled"]);

    useSidebarLayoutStore.getState().setAssistantId("asst-1");

    expect(useSidebarLayoutStore.getState().openCategories).toEqual([
      "scheduled",
    ]);
  });

  test("setOpenCategories persists to localStorage", () => {
    useSidebarLayoutStore.getState().setAssistantId("asst-1");
    useSidebarLayoutStore
      .getState()
      .setOpenCategories(["scheduled", "background"]);

    const raw = localStorage.getItem("vellum:sidebar-open-categories:asst-1");
    expect(JSON.parse(raw!)).toEqual(["scheduled", "background"]);
    expect(useSidebarLayoutStore.getState().openCategories).toEqual([
      "scheduled",
      "background",
    ]);
  });

  test("setOpenCustomGroups persists to localStorage", () => {
    useSidebarLayoutStore.getState().setAssistantId("asst-1");
    useSidebarLayoutStore.getState().setOpenCustomGroups(["grp-1", "grp-2"]);

    const raw = localStorage.getItem(
      "vellum:sidebar-open-custom-groups:asst-1",
    );
    expect(JSON.parse(raw!)).toEqual(["grp-1", "grp-2"]);
  });

  test("switching assistant re-hydrates from new assistant's storage", () => {
    localStorage.setItem(
      "vellum:sidebar-open-categories:asst-1",
      JSON.stringify(["scheduled"]),
    );
    localStorage.setItem(
      "vellum:sidebar-open-categories:asst-2",
      JSON.stringify(["background", channelSectionKey("slack")]),
    );

    useSidebarLayoutStore.getState().setAssistantId("asst-1");
    expect(useSidebarLayoutStore.getState().openCategories).toEqual([
      "scheduled",
    ]);

    useSidebarLayoutStore.getState().setAssistantId("asst-2");
    expect(useSidebarLayoutStore.getState().openCategories).toEqual([
      "background",
      channelSectionKey("slack"),
    ]);
  });

  test("falls back to defaults when localStorage has invalid data", () => {
    localStorage.setItem("vellum:sidebar-open-categories:asst-1", "not-json");

    useSidebarLayoutStore.getState().setAssistantId("asst-1");

    expect(useSidebarLayoutStore.getState().openCategories).toEqual([]);
  });

  test("setOpenCategories does not persist when no assistantId is set", () => {
    useSidebarLayoutStore.getState().setOpenCategories(["scheduled"]);

    expect(useSidebarLayoutStore.getState().openCategories).toEqual([
      "scheduled",
    ]);
    expect(localStorage.length).toBe(0);
  });

  test("openPrimary defaults to Pinned + Chats open when nothing is stored", () => {
    useSidebarLayoutStore.getState().setAssistantId("asst-1");
    expect(useSidebarLayoutStore.getState().openPrimary).toEqual([
      "pinned",
      "recents",
    ]);
  });

  test("setOpenPrimary persists to localStorage", () => {
    useSidebarLayoutStore.getState().setAssistantId("asst-1");
    useSidebarLayoutStore.getState().setOpenPrimary(["pinned"]);

    const raw = localStorage.getItem("vellum:sidebar-open-primary:asst-1");
    expect(JSON.parse(raw!)).toEqual(["pinned"]);
    expect(useSidebarLayoutStore.getState().openPrimary).toEqual(["pinned"]);
  });

  test("setAssistantId hydrates a collapsed primary section from storage", () => {
    // Stored empty array = user collapsed both; must not fall back to open.
    localStorage.setItem(
      "vellum:sidebar-open-primary:asst-1",
      JSON.stringify([]),
    );
    useSidebarLayoutStore.getState().setAssistantId("asst-1");
    expect(useSidebarLayoutStore.getState().openPrimary).toEqual([]);
  });
});

// The view mode is deliberately not held in this store: it reads from
// storage directly so it survives the first paint. See
// sidebar-view-mode.test.ts.
