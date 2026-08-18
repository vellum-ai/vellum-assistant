/**
 * The reported case is the one Radix `Slot` cannot serve: the clone composes a
 * ref and merges props only when `children.type !== Fragment`, so a fragment
 * child renders with none of the parent's styling and holds no ref.
 *
 * @see https://www.radix-ui.com/primitives/docs/utilities/slot
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createElement, Fragment } from "react";

import { reportUnmergeableSlotChild } from "./slot-child";

const errorSpy = spyOn(console, "error");

afterEach(() => {
  errorSpy.mockClear();
});

describe("reportUnmergeableSlotChild", () => {
  test("reports a fragment child, naming the component", () => {
    errorSpy.mockImplementation(() => {});

    reportUnmergeableSlotChild(
      "PanelItem",
      createElement(Fragment, null, "Pinned"),
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("PanelItem");
  });

  test("stays quiet for an element, which is what the slot merges onto", () => {
    errorSpy.mockImplementation(() => {});

    reportUnmergeableSlotChild(
      "PanelItem",
      createElement("button", { type: "button" }, "Pinned"),
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("stays quiet for a string, which the type already rejects", () => {
    errorSpy.mockImplementation(() => {});

    reportUnmergeableSlotChild("PanelItem", "Pinned");

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
