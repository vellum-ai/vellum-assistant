import { describe, expect, test } from "bun:test";

import {
  parseStoredActions,
  restoreSurfaceStateEntry,
} from "../daemon/conversation-surface-state.js";

describe("restoreSurfaceStateEntry", () => {
  test("preserves persisted data verbatim, including keys the canonical schema does not model", () => {
    // A card whose persisted data carries a key outside CardSurfaceDataSchema
    // (a client-owned/legacy field). Restore must keep it — the entry feeds
    // the `GET /v1/surfaces/:id` in-memory fast path, and re-parsing here
    // would strip it and regress display on reload.
    const entry = restoreSurfaceStateEntry({
      type: "ui_surface",
      surfaceId: "s1",
      surfaceType: "card",
      data: { title: "Hi", clientOwnedField: { nested: true } },
      title: "Hi",
    });

    expect(entry.surfaceType).toBe("card");
    expect(entry.data).toEqual({
      title: "Hi",
      clientOwnedField: { nested: true },
    });
  });

  test("survives a reload round-trip for a surface whose client reads keys outside the daemon schema", () => {
    // document_preview's client renderer reads `content` and `mimeType`, which
    // DocumentPreviewSurfaceDataSchema does not model. A persisted block
    // carrying them must round-trip through restore (the GET fast path) with
    // those keys intact — re-parsing through the schema would strip them and
    // blank the preview on reload.
    const persistedBlock = {
      type: "ui_surface",
      surfaceId: "doc-1",
      surfaceType: "document_preview",
      title: "Notes",
      data: {
        title: "Notes",
        surfaceId: "doc-real",
        content: "# Heading\n\nbody",
        mimeType: "text/markdown",
      },
    };

    const entry = restoreSurfaceStateEntry(persistedBlock);

    expect(entry.surfaceType).toBe("document_preview");
    expect(entry.data).toEqual(persistedBlock.data);
    expect((entry.data as Record<string, unknown>).mimeType).toBe(
      "text/markdown",
    );
  });

  test("preserves daemon-internal surface types and their opaque data", () => {
    const entry = restoreSurfaceStateEntry({
      surfaceType: "skill_card",
      data: { skills: [{ name: "foo" }], cta: "Add" },
    });

    expect(entry.surfaceType).toBe("skill_card");
    expect(entry.data).toEqual({ skills: [{ name: "foo" }], cta: "Add" });
  });

  test("preserves an unknown but non-empty surfaceType verbatim (future/custom surfaces)", () => {
    const entry = restoreSurfaceStateEntry({
      surfaceType: "some_future_surface",
      data: { keep: "me" },
    });

    // The recorded type must survive restart so the client renders the surface
    // it recorded rather than a coerced dynamic_page. (The verbatim string is
    // carried under the SurfaceType-typed field via the restore boundary cast.)
    expect(entry.surfaceType as string).toBe("some_future_surface");
    expect(entry.data).toEqual({ keep: "me" });
  });

  test("falls back to dynamic_page only when surfaceType is missing or blank", () => {
    expect(restoreSurfaceStateEntry({ data: {} }).surfaceType).toBe(
      "dynamic_page",
    );
    expect(
      restoreSurfaceStateEntry({ surfaceType: "   ", data: {} }).surfaceType,
    ).toBe("dynamic_page");
    expect(
      restoreSurfaceStateEntry({ surfaceType: 42, data: {} }).surfaceType,
    ).toBe("dynamic_page");
  });

  test("rehydrates the daemon-only activationMoment tag and drops a malformed one", () => {
    const valid = restoreSurfaceStateEntry({
      surfaceType: "card",
      data: {},
      activationMoment: "first_wow_executed",
    });
    expect(valid.activationMoment).toBe("first_wow_executed");

    const invalid = restoreSurfaceStateEntry({
      surfaceType: "card",
      data: {},
      activationMoment: "not_a_real_moment",
    });
    expect(invalid.activationMoment).toBeUndefined();
  });
});

describe("parseStoredActions", () => {
  test("keeps well-formed actions and drops entries missing id or label", () => {
    expect(
      parseStoredActions([
        { id: "a", label: "A", style: "primary", data: { x: 1 } },
        { id: "b" },
        { label: "no id" },
        "not an object",
      ]),
    ).toEqual([{ id: "a", label: "A", style: "primary", data: { x: 1 } }]);
  });

  test("returns undefined for a non-array", () => {
    expect(parseStoredActions(undefined)).toBeUndefined();
    expect(parseStoredActions("nope")).toBeUndefined();
  });
});
