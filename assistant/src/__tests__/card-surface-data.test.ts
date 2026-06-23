import { describe, expect, test } from "bun:test";

import {
  cardHasRenderableContent,
  CardSurfaceDataSchema,
} from "../api/surfaces.js";

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

describe("cardHasRenderableContent", () => {
  test("empty object has no renderable content", () => {
    expect(cardHasRenderableContent({})).toBe(false);
  });

  test("title-only has no renderable content", () => {
    expect(cardHasRenderableContent({ title: "Hello" })).toBe(false);
  });

  test("body counts as renderable content", () => {
    expect(cardHasRenderableContent({ body: "Some text" })).toBe(true);
  });

  test("whitespace-only body is not renderable content", () => {
    expect(cardHasRenderableContent({ body: "   " })).toBe(false);
  });

  test("subtitle counts as renderable content", () => {
    expect(cardHasRenderableContent({ subtitle: "Sub" })).toBe(true);
  });

  test("metadata counts as renderable content", () => {
    expect(
      cardHasRenderableContent({
        metadata: [{ label: "Key", value: "Val" }],
      }),
    ).toBe(true);
  });

  test("empty metadata array is not renderable content", () => {
    expect(cardHasRenderableContent({ metadata: [] })).toBe(false);
  });

  test("template counts as renderable content", () => {
    expect(cardHasRenderableContent({ template: "task_progress" })).toBe(true);
  });
});
