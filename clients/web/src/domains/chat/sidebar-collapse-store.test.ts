import { afterEach, describe, expect, test } from "bun:test";

import { useSidebarCollapseStore } from "@/domains/chat/sidebar-collapse-store";
import { channelSectionKey } from "@/domains/chat/utils/sidebar-group-collapse-storage";

function resetStore() {
  useSidebarCollapseStore.setState({
    assistantId: null,
    openCategories: [],
    openCustomGroups: [],
    backgroundActivated: false,
    scheduledActivated: false,
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
      JSON.stringify(["background", channelSectionKey("slack")]),
    );

    useSidebarCollapseStore.getState().setAssistantId("asst-1");
    expect(useSidebarCollapseStore.getState().openCategories).toEqual([
      "scheduled",
    ]);

    useSidebarCollapseStore.getState().setAssistantId("asst-2");
    expect(useSidebarCollapseStore.getState().openCategories).toEqual([
      "background",
      channelSectionKey("slack"),
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

describe("SidebarCollapseStore — independent lazy-section activation", () => {
  test("both activation flags default to false", () => {
    const state = useSidebarCollapseStore.getState();
    expect(state.backgroundActivated).toBe(false);
    expect(state.scheduledActivated).toBe(false);
  });

  test("activateBackground reveals Background without activating Scheduled", () => {
    /**
     * The Background and Scheduled lists are separate lazy queries;
     * revealing one must never trigger the other's fetch.
     */

    // WHEN only the Background section is revealed
    useSidebarCollapseStore.getState().activateBackground();

    // THEN Background is activated and Scheduled stays dormant
    const state = useSidebarCollapseStore.getState();
    expect(state.backgroundActivated).toBe(true);
    expect(state.scheduledActivated).toBe(false);
  });

  test("activateScheduled reveals Scheduled without activating Background", () => {
    /**
     * The mirror case: revealing Scheduled leaves Background dormant.
     */

    // WHEN only the Scheduled section is revealed
    useSidebarCollapseStore.getState().activateScheduled();

    // THEN Scheduled is activated and Background stays dormant
    const state = useSidebarCollapseStore.getState();
    expect(state.scheduledActivated).toBe(true);
    expect(state.backgroundActivated).toBe(false);
  });

  test("expanding the Background category activates only Background", () => {
    /**
     * Expanding a section in the full sidebar counts as a reveal, but it
     * must activate that section's query alone.
     */

    // GIVEN an assistant is selected
    useSidebarCollapseStore.getState().setAssistantId("asst-1");

    // WHEN the Background category is expanded
    useSidebarCollapseStore.getState().setOpenCategories(["background"]);

    // THEN only Background is activated
    const state = useSidebarCollapseStore.getState();
    expect(state.backgroundActivated).toBe(true);
    expect(state.scheduledActivated).toBe(false);
  });

  test("setAssistantId hydrates each activation flag from persisted categories independently", () => {
    /**
     * A persisted open section counts as a reveal on load, but only for
     * the section that was actually left open.
     */

    // GIVEN only Scheduled was persisted as open for this assistant
    localStorage.setItem(
      "vellum:sidebar-open-categories:asst-1",
      JSON.stringify(["scheduled"]),
    );

    // WHEN the assistant is selected
    useSidebarCollapseStore.getState().setAssistantId("asst-1");

    // THEN Scheduled activates from storage and Background stays dormant
    const state = useSidebarCollapseStore.getState();
    expect(state.scheduledActivated).toBe(true);
    expect(state.backgroundActivated).toBe(false);
  });

  test("switching assistant resets activation flags for the new assistant", () => {
    /**
     * Activation is per session and per assistant: a section revealed on
     * one assistant must not leak its lazy fetch onto the next.
     */

    // GIVEN Background was revealed on the first assistant
    useSidebarCollapseStore.getState().setAssistantId("asst-1");
    useSidebarCollapseStore.getState().activateBackground();
    expect(useSidebarCollapseStore.getState().backgroundActivated).toBe(true);

    // WHEN switching to a second assistant with nothing persisted
    useSidebarCollapseStore.getState().setAssistantId("asst-2");

    // THEN both activation flags reset for the new assistant
    const state = useSidebarCollapseStore.getState();
    expect(state.backgroundActivated).toBe(false);
    expect(state.scheduledActivated).toBe(false);
  });
});
