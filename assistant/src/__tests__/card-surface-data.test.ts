import { describe, expect, test } from "bun:test";

import { CardSurfaceDataSchema } from "../api/surfaces.js";

// The wire keeps surface `data` opaque and the stream drops events that fail to
// parse, so the canonical card schema must never reject a real payload: every
// field is optional and unknown keys are stripped. The daemon's `ui_show`
// normalizer parses against this schema and logs the stripped keys — that is
// how unsupported shapes are surfaced rather than silently swallowed.
describe("CardSurfaceDataSchema", () => {
  test("parses an empty object", () => {
    expect(CardSurfaceDataSchema.safeParse({}).success).toBe(true);
  });

  test("parses a title-less card and strips unknown keys", () => {
    const parsed = CardSurfaceDataSchema.safeParse({
      body: "hi",
      surfaceWidgetHint: "ignored",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ body: "hi" });
    }
  });

  test("a body-less, title-only card is still valid (renders its title)", () => {
    expect(CardSurfaceDataSchema.safeParse({ title: "Heads up" }).success).toBe(
      true,
    );
  });

  test("coerces primitive metadata values to strings", () => {
    const parsed = CardSurfaceDataSchema.safeParse({
      metadata: [
        { label: "Docs", value: 12 },
        { label: "Passed", value: true },
        { label: "Status", value: "OK" },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.metadata).toEqual([
        { label: "Docs", value: "12" },
        { label: "Passed", value: "true" },
        { label: "Status", value: "OK" },
      ]);
    }
  });

  test("the schema's keys define what the normalizer supports", () => {
    expect(Object.keys(CardSurfaceDataSchema.shape).sort()).toEqual([
      "body",
      "metadata",
      "subtitle",
      "template",
      "templateData",
      "title",
    ]);
  });
});
