import { describe, expect, test } from "bun:test";

import {
  parseSurfaceShowResultId,
  withSurfaceShowNote,
} from "./surface-show-result.js";

const HINT_WITH_BRACES =
  'As each step finishes, call ui_update { surface_id: "<id>", data: { templateData: { steps: [{ label: "x", status: "completed" }] } } }';

describe("parseSurfaceShowResultId", () => {
  test("reads the id from a bare envelope", () => {
    expect(parseSurfaceShowResultId('{"surfaceId":"s-1"}')).toBe("s-1");
  });

  test("reads the id from an envelope carrying advisory fields", () => {
    expect(
      parseSurfaceShowResultId(
        JSON.stringify({ surfaceId: "s-2", note: "hi", status: "displayed" }),
      ),
    ).toBe("s-2");
  });

  test("tolerates prose appended after the envelope, even prose with braces", () => {
    expect(
      parseSurfaceShowResultId(`{"surfaceId":"s-3"}\n\n${HINT_WITH_BRACES}`),
    ).toBe("s-3");
  });

  test("ignores braces inside string values when finding the envelope end", () => {
    expect(
      parseSurfaceShowResultId(
        '{"surfaceId":"s-4","note":"use { and } freely \\" }"} trailing',
      ),
    ).toBe("s-4");
  });

  test("returns undefined for non-envelope content", () => {
    expect(parseSurfaceShowResultId("Surface updated")).toBeUndefined();
    expect(parseSurfaceShowResultId("")).toBeUndefined();
    expect(parseSurfaceShowResultId('{"surfaceId":1}')).toBeUndefined();
    expect(parseSurfaceShowResultId('{"other":"x"}')).toBeUndefined();
    expect(parseSurfaceShowResultId('{"surfaceId":"unterminated')).toBe(
      undefined,
    );
  });
});

describe("withSurfaceShowNote", () => {
  test("carries the note inside the envelope so the id stays parseable", () => {
    const content = withSurfaceShowNote(
      JSON.stringify({ surfaceId: "s-1" }),
      HINT_WITH_BRACES,
    );
    expect(JSON.parse(content)).toEqual({
      surfaceId: "s-1",
      note: HINT_WITH_BRACES,
    });
    expect(parseSurfaceShowResultId(content)).toBe("s-1");
  });

  test("appends to an existing note rather than replacing it", () => {
    const content = withSurfaceShowNote(
      JSON.stringify({ surfaceId: "s-1", note: "first" }),
      "second",
    );
    expect(JSON.parse(content)).toEqual({
      surfaceId: "s-1",
      note: "first\n\nsecond",
    });
  });

  test("appends as prose when the content is not a surface envelope", () => {
    expect(withSurfaceShowNote("Surface displayed", "note")).toBe(
      "Surface displayed\n\nnote",
    );
  });
});
