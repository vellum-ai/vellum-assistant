import { describe, expect, test } from "bun:test";

import { isSurfaceInteractive, type Surface } from "@/domains/chat/types/types";

function makeSurface(
  overrides: Partial<Surface> = {},
): Surface {
  return {
    surfaceId: "test-surface",
    surfaceType: "card",
    data: {},
    ...overrides,
  };
}

describe("isSurfaceInteractive", () => {
  test("card without actions is not interactive", () => {
    expect(isSurfaceInteractive(makeSurface({ surfaceType: "card" }))).toBe(false);
  });

  test("card with actions is interactive", () => {
    expect(
      isSurfaceInteractive(
        makeSurface({
          surfaceType: "card",
          actions: [{ id: "ok", label: "OK" }],
        }),
      ),
    ).toBe(true);
  });

  test("table without actions is not interactive", () => {
    expect(isSurfaceInteractive(makeSurface({ surfaceType: "table" }))).toBe(false);
  });

  test("table with actions is interactive", () => {
    expect(
      isSurfaceInteractive(
        makeSurface({
          surfaceType: "table",
          actions: [{ id: "select", label: "Select" }],
        }),
      ),
    ).toBe(true);
  });

  test("list without actions is not interactive", () => {
    expect(isSurfaceInteractive(makeSurface({ surfaceType: "list" }))).toBe(false);
  });

  test("list with actions is interactive", () => {
    expect(
      isSurfaceInteractive(
        makeSurface({
          surfaceType: "list",
          actions: [{ id: "pick", label: "Pick" }],
        }),
      ),
    ).toBe(true);
  });

  test("form is always interactive", () => {
    expect(isSurfaceInteractive(makeSurface({ surfaceType: "form" }))).toBe(true);
  });

  test("confirmation is always interactive", () => {
    expect(isSurfaceInteractive(makeSurface({ surfaceType: "confirmation" }))).toBe(true);
  });

  test("file_upload is always interactive", () => {
    expect(isSurfaceInteractive(makeSurface({ surfaceType: "file_upload" }))).toBe(true);
  });

  test("dynamic_page without actions is not interactive", () => {
    expect(isSurfaceInteractive(makeSurface({ surfaceType: "dynamic_page" }))).toBe(false);
  });

  test("dynamic_page with actions is interactive", () => {
    expect(
      isSurfaceInteractive(
        makeSurface({
          surfaceType: "dynamic_page",
          actions: [{ id: "close", label: "Close" }],
        }),
      ),
    ).toBe(true);
  });

  test("card with empty actions array is not interactive", () => {
    expect(
      isSurfaceInteractive(makeSurface({ surfaceType: "card", actions: [] })),
    ).toBe(false);
  });
});
