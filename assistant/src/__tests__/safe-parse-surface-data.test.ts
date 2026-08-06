import { describe, expect, test } from "bun:test";

import { safeParseSurfaceData, type SurfaceType } from "../api/surfaces.js";

describe("safeParseSurfaceData", () => {
  test("parses a known surface type through its canonical schema", () => {
    expect(safeParseSurfaceData("copy_block", { text: "hello" })).toEqual({
      text: "hello",
    });
  });

  test("returns undefined (never throws) for an out-of-enum surface type", () => {
    // The `<K extends SurfaceType>` signature keeps typed callers honest, but a
    // JS caller — or a runtime string widened past the type system — can still
    // reach this helper with a type that has no entry in `SURFACE_DATA_SCHEMAS`.
    // Indexing it then yields `undefined`, and the helper must return `undefined`
    // (its "couldn't produce a typed payload" signal) rather than throwing on
    // `undefined.safeParse`.
    const unknownType = "future_widget" as SurfaceType;
    expect(() =>
      safeParseSurfaceData(unknownType, { any: "data" }),
    ).not.toThrow();
    expect(safeParseSurfaceData(unknownType, { any: "data" })).toBeUndefined();
  });
});
