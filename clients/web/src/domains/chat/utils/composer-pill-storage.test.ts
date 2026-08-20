import { afterEach, describe, expect, test } from "bun:test";

import {
  clearComposerPillAccessPreset,
  clearComposerPillProfileLabel,
  loadComposerPillSnapshot,
  saveComposerPillAccessPreset,
  saveComposerPillProfileLabel,
} from "@/domains/chat/utils/composer-pill-storage";
import { clearUserScopedOverrides } from "@/utils/typed-storage";

const KEY = (assistantId: string) => `vellum:composerPills:${assistantId}`;

afterEach(() => {
  localStorage.clear();
  // Accessors are module singletons, so a value held after a rejected write
  // outlives the test that set it. Logout clears these for the same reason.
  clearUserScopedOverrides();
});

describe("composer pill snapshot storage", () => {
  test("reads empty before anything is stored", () => {
    expect(loadComposerPillSnapshot("asst-1")).toEqual({
      accessPresetId: null,
      profileLabel: null,
    });
  });

  test("each field merges into the stored snapshot instead of replacing it", () => {
    saveComposerPillAccessPreset("asst-1", "relaxed");
    saveComposerPillProfileLabel("asst-1", "Balanced");

    expect(loadComposerPillSnapshot("asst-1")).toEqual({
      accessPresetId: "relaxed",
      profileLabel: "Balanced",
    });
  });

  test("scopes the snapshot per assistant", () => {
    saveComposerPillProfileLabel("asst-1", "Balanced");

    expect(loadComposerPillSnapshot("asst-2").profileLabel).toBeNull();
  });

  test("a later write replaces the field it owns", () => {
    saveComposerPillProfileLabel("asst-1", "Balanced");
    saveComposerPillProfileLabel("asst-1", "Quality");

    expect(loadComposerPillSnapshot("asst-1").profileLabel).toBe("Quality");
  });

  test("writes under a user-scoped key so logout clears it", () => {
    saveComposerPillAccessPreset("asst-1", "relaxed");

    expect(localStorage.getItem(KEY("asst-1"))).toContain("relaxed");
  });

  test("a malformed payload reads as empty rather than throwing", () => {
    localStorage.setItem(KEY("asst-1"), "{not json");

    expect(loadComposerPillSnapshot("asst-1")).toEqual({
      accessPresetId: null,
      profileLabel: null,
    });
  });

  test("clearing the access preset keeps the profile label", () => {
    saveComposerPillAccessPreset("asst-1", "relaxed");
    saveComposerPillProfileLabel("asst-1", "Balanced");

    clearComposerPillAccessPreset("asst-1");

    expect(loadComposerPillSnapshot("asst-1")).toEqual({
      accessPresetId: null,
      profileLabel: "Balanced",
    });
  });

  test("clearing an empty snapshot writes nothing", () => {
    clearComposerPillAccessPreset("asst-1");

    expect(localStorage.getItem(KEY("asst-1"))).toBeNull();
  });

  test("clearing the profile label keeps the access preset", () => {
    saveComposerPillAccessPreset("asst-1", "relaxed");
    saveComposerPillProfileLabel("asst-1", "Balanced");

    clearComposerPillProfileLabel("asst-1");

    expect(loadComposerPillSnapshot("asst-1")).toEqual({
      accessPresetId: "relaxed",
      profileLabel: null,
    });
  });

  test("non-string fields are dropped, keeping the usable half", () => {
    localStorage.setItem(
      KEY("asst-1"),
      JSON.stringify({ accessPresetId: 7, profileLabel: "Balanced" }),
    );

    expect(loadComposerPillSnapshot("asst-1")).toEqual({
      accessPresetId: null,
      profileLabel: "Balanced",
    });
  });
});
