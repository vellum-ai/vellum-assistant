import { afterEach, describe, expect, test } from "bun:test";

import { useSidebarCollapseStore } from "@/domains/chat/sidebar-collapse-store";

function resetStore() {
  useSidebarCollapseStore.setState({
    assistantId: null,
    openCategories: [],
    openCustomGroups: [],
  });
}

afterEach(() => {
  resetStore();
  localStorage.clear();
});

describe("SidebarCollapseStore", () => {
  test("defaults to no open categories or custom groups", () => {
    const state = useSidebarCollapseStore.getState();
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

    useSidebarCollapseStore.getState().setAssistantId("asst-1");

    const state = useSidebarCollapseStore.getState();
    expect(state.assistantId).toBe("asst-1");
    expect(state.openCategories).toEqual(["scheduled", "background"]);
    expect(state.openCustomGroups).toEqual(["grp-abc"]);
  });

  test("setAssistantId no-ops when assistantId is unchanged", () => {
    useSidebarCollapseStore.getState().setAssistantId("asst-1");
    useSidebarCollapseStore.getState().setOpenCategories(["scheduled"]);

    useSidebarCollapseStore.getState().setAssistantId("asst-1");

    expect(useSidebarCollapseStore.getState().openCategories).toEqual([
      "scheduled",
    ]);
  });

  test("setOpenCategories persists to localStorage", () => {
    useSidebarCollapseStore.getState().setAssistantId("asst-1");
    useSidebarCollapseStore
      .getState()
      .setOpenCategories(["scheduled", "background"]);

    const raw = localStorage.getItem(
      "vellum:sidebar-open-categories:asst-1",
    );
    expect(JSON.parse(raw!)).toEqual(["scheduled", "background"]);
    expect(useSidebarCollapseStore.getState().openCategories).toEqual([
      "scheduled",
      "background",
    ]);
  });

  test("setOpenCustomGroups persists to localStorage", () => {
    useSidebarCollapseStore.getState().setAssistantId("asst-1");
    useSidebarCollapseStore
      .getState()
      .setOpenCustomGroups(["grp-1", "grp-2"]);

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
      JSON.stringify(["background", "slack"]),
    );

    useSidebarCollapseStore.getState().setAssistantId("asst-1");
    expect(useSidebarCollapseStore.getState().openCategories).toEqual([
      "scheduled",
    ]);

    useSidebarCollapseStore.getState().setAssistantId("asst-2");
    expect(useSidebarCollapseStore.getState().openCategories).toEqual([
      "background",
      "slack",
    ]);
  });

  test("falls back to defaults when localStorage has invalid data", () => {
    localStorage.setItem(
      "vellum:sidebar-open-categories:asst-1",
      "not-json",
    );

    useSidebarCollapseStore.getState().setAssistantId("asst-1");

    expect(useSidebarCollapseStore.getState().openCategories).toEqual([]);
  });

  test("setOpenCategories does not persist when no assistantId is set", () => {
    useSidebarCollapseStore.getState().setOpenCategories(["scheduled"]);

    expect(useSidebarCollapseStore.getState().openCategories).toEqual([
      "scheduled",
    ]);
    expect(localStorage.length).toBe(0);
  });
});
