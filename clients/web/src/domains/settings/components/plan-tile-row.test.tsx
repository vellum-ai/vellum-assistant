/**
 * The stacking contract both the resolved plan card and its skeleton lean on:
 * the tiles stack below `lg` and sit side by side at equal height above it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { PlanTileRow } from "./plan-tile-row";

afterEach(cleanup);

describe("PlanTileRow", () => {
  test("stacks the tiles below lg and rows them side by side above it", () => {
    const { getByTestId } = render(
      <PlanTileRow>
        <div data-testid="first-tile" />
        <div data-testid="second-tile" />
      </PlanTileRow>,
    );

    const row = getByTestId("first-tile").parentElement;
    expect(getByTestId("second-tile").parentElement).toBe(row);
    expect(row?.className).toContain("flex-col");
    expect(row?.className).toContain("lg:flex-row");
    expect(row?.className).toContain("lg:items-stretch");
  });
});
