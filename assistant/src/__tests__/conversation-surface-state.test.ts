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

  test("preserves daemon-internal surface types and their opaque data", () => {
    const entry = restoreSurfaceStateEntry({
      surfaceType: "skill_card",
      data: { skills: [{ name: "foo" }], cta: "Add" },
    });

    expect(entry.surfaceType).toBe("skill_card");
    expect(entry.data).toEqual({ skills: [{ name: "foo" }], cta: "Add" });
  });

  test("falls back to dynamic_page for an unrecognized surfaceType while keeping data", () => {
    const entry = restoreSurfaceStateEntry({
      surfaceType: "totally_unknown",
      data: { keep: "me" },
    });

    expect(entry.surfaceType).toBe("dynamic_page");
    expect(entry.data).toEqual({ keep: "me" });
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
