import { describe, expect, test } from "bun:test";

import {
  buildShareTargetSnapshot,
  type HelperShareTarget,
  SHARE_TARGETS_MAX,
} from "./share-targets";

const SURFACE = { x: 0, y: 0, width: 1000, height: 500 };

const control = (
  label: string,
  overrides: Partial<HelperShareTarget> = {},
): HelperShareTarget => ({
  label,
  role: "AXButton",
  x: 100,
  y: 100,
  width: 80,
  height: 24,
  ...overrides,
});

describe("buildShareTargetSnapshot", () => {
  test("offers the tree's own name, which can differ from the visible label", () => {
    const snapshot = buildShareTargetSnapshot(
      [control("root_Filters", { x: 500, y: 50, width: 100, height: 50 })],
      SURFACE,
    );
    expect(snapshot).toEqual({
      targets: [
        {
          id: expect.stringMatching(/^t[0-9a-z]+$/),
          label: "root_Filters",
          role: "AXButton",
          x: 0.5,
          y: 0.1,
          width: 0.1,
          height: 0.1,
        },
      ],
      total: 1,
    });
  });

  test("measures against the surface's origin", () => {
    const [target] = buildShareTargetSnapshot(
      [control("Send", { x: 1100, y: 300, width: 100, height: 50 })],
      { x: 1000, y: 200, width: 500, height: 250 },
    ).targets;
    expect(target).toMatchObject({ x: 0.2, y: 0.4, width: 0.2, height: 0.2 });
  });

  test("drops collapsed 1pt rows, blank names and overlong text", () => {
    const snapshot = buildShareTargetSnapshot(
      [
        control("Collapsed row", { height: 1 }),
        control("Thin column", { width: 1 }),
        control("   "),
        control("x".repeat(121)),
        control("Keep"),
      ],
      SURFACE,
      5,
    );
    expect(snapshot.targets.map((t) => t.label)).toEqual(["Keep"]);
    expect(snapshot.total).toBe(5);
  });

  test("drops controls whose middle is off the surface", () => {
    const snapshot = buildShareTargetSnapshot(
      [
        control("Left of it", { x: -200, width: 100 }),
        control("Below it", { y: 600 }),
        control("Half on", { x: 960, width: 60 }),
      ],
      SURFACE,
    );
    expect(snapshot.targets.map((t) => t.label)).toEqual(["Half on"]);
  });

  test("offers a repeated name once, with how many carry it", () => {
    const snapshot = buildShareTargetSnapshot(
      [control("Close"), control("Save"), control("Close", { x: 400 })],
      SURFACE,
    );
    expect(snapshot.targets).toEqual([
      expect.objectContaining({ label: "Close", duplicates: 2 }),
      expect.objectContaining({ label: "Save" }),
    ]);
    expect(snapshot.targets[1]).not.toHaveProperty("duplicates");
  });

  test("collapses whitespace in a name", () => {
    const [target] = buildShareTargetSnapshot(
      [control("My\n  Media")],
      SURFACE,
    ).targets;
    expect(target?.label).toBe("My Media");
  });

  test("over the cap, keeps interactive roles first and tree order after", () => {
    const text = Array.from({ length: SHARE_TARGETS_MAX }, (_, i) =>
      control(`Text ${i}`, { role: "AXStaticText" }),
    );
    const snapshot = buildShareTargetSnapshot(
      [...text, control("Export", { role: "AXButton" })],
      SURFACE,
    );
    expect(snapshot.targets).toHaveLength(SHARE_TARGETS_MAX);
    // The button survives the cap, and stays where the tree put it.
    expect(snapshot.targets.at(-1)?.label).toBe("Export");
    expect(snapshot.targets.at(-2)?.label).toBe(
      `Text ${SHARE_TARGETS_MAX - 2}`,
    );
  });

  test("an id follows the control from one snapshot to the next", () => {
    const first = buildShareTargetSnapshot(
      [control("Save"), control("Export")],
      SURFACE,
    );
    // The page moved and a control appeared ahead of them.
    const second = buildShareTargetSnapshot(
      [control("New"), control("Export", { y: 300 }), control("Save")],
      SURFACE,
    );
    const idOf = (snapshot: typeof first, label: string) =>
      snapshot.targets.find((t) => t.label === label)?.id;
    expect(idOf(second, "Save")).toBe(idOf(first, "Save"));
    expect(idOf(second, "Export")).toBe(idOf(first, "Export"));
    expect(new Set(second.targets.map((t) => t.id)).size).toBe(3);
    // Same name, different role: a different control.
    const asText = buildShareTargetSnapshot(
      [control("Save", { role: "AXStaticText" })],
      SURFACE,
    );
    expect(idOf(asText, "Save")).not.toBe(idOf(first, "Save"));
  });

  test("carries the nearest named container as the section", () => {
    const snapshot = buildShareTargetSnapshot(
      [
        control("Inbox", { role: "AXRow", section: "Mailboxes" }),
        control("Send", { section: "  " }),
      ],
      SURFACE,
    );
    expect(snapshot.targets[0]?.section).toBe("Mailboxes");
    expect(snapshot.targets[1]).not.toHaveProperty("section");
  });

  test("an empty surface offers nothing", () => {
    expect(
      buildShareTargetSnapshot([control("Send")], {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      }),
    ).toEqual({ targets: [], total: 1 });
  });
});
