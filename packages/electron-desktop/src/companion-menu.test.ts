import { describe, expect, test } from "bun:test";
import type { CompanionSize, CompanionSizeAxis } from "@vellumai/ipc-contract";

import { companionSizeSubmenus } from "./companion-menu";

/**
 * The size pickers both companion menus draw, built once.
 *
 * The tray and the surface's own right-click read this builder, so what is
 * worth stating here is what a menu is read for: the headings, the steps under
 * them, which one is marked, and that a press carries the axis it was made
 * under. The two callers then only have to state what is theirs, which is where
 * the items sit and whether they stand down.
 */
describe("companionSizeSubmenus", () => {
  /** Only what a menu item is read for here. */
  type MenuItem = {
    label?: string;
    enabled?: boolean;
    type?: string;
    checked?: boolean;
    click?: () => void;
    submenu?: MenuItem[];
  };

  const build = (
    current: Record<CompanionSizeAxis, CompanionSize> = {
      avatar: "small",
      options: "small",
    },
    options?: { enabled?: boolean },
  ) => {
    const picked: [CompanionSizeAxis, CompanionSize][] = [];
    const items = companionSizeSubmenus(
      current,
      (axis, size) => {
        picked.push([axis, size]);
      },
      options,
    ) as MenuItem[];
    return { items, picked };
  };

  test("offers a heading for each thing that is sized", () => {
    expect(build().items.map((item) => item.label)).toEqual([
      "Avatar size",
      "Options size",
    ]);
  });

  test("offers every named step under each heading, as one radio group", () => {
    for (const heading of build().items) {
      expect(heading.submenu?.map((item) => item.label)).toEqual([
        "Small",
        "Medium",
        "Large",
        "Huge",
        "Ridiculous",
      ]);
      expect(heading.submenu?.every((item) => item.type === "radio")).toBe(
        true,
      );
    }
  });

  /**
   * The whole point of two submenus: each shows where its own axis is, so a
   * user who has made the creature enormous and left the controls alone can see
   * exactly that.
   */
  test("marks the step each axis is on, and only that one", () => {
    const { items } = build({ avatar: "ridiculous", options: "medium" });
    expect(
      items[0]?.submenu?.filter((item) => item.checked).map((i) => i.label),
    ).toEqual(["Ridiculous"]);
    expect(
      items[1]?.submenu?.filter((item) => item.checked).map((i) => i.label),
    ).toEqual(["Medium"]);
  });

  test("a pick carries the axis it was made under", () => {
    const menu = build();
    menu.items[0]?.submenu?.[3]?.click?.();
    menu.items[1]?.submenu?.[4]?.click?.();
    expect(menu.picked).toEqual([
      ["avatar", "huge"],
      ["options", "ridiculous"],
    ]);
  });

  /**
   * The headings stand down rather than disappear for the menu that also offers
   * a way to hide the surface. Left to itself the builder hands back live items,
   * which is what a menu drawn on the surface itself wants.
   */
  test("is enabled unless the caller says otherwise", () => {
    expect(build().items.map((item) => item.enabled)).toEqual([true, true]);
    expect(
      build(undefined, { enabled: false }).items.map((item) => item.enabled),
    ).toEqual([false, false]);
  });
});
