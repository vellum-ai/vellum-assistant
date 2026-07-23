/**
 * Error-surfacing test for the installed inventory (isolated in its own file
 * because `mock.module` is process-global).
 *
 * When a section cannot be enumerated, `collectInstalledInventory` must record
 * the failure under `errors` — never return an empty section that reads as
 * "nothing installed". This drives the export to keep the failure visible in
 * the bundle instead of writing a falsely-successful `installed-inventory.json`.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("../../../../skills/available-skills.js", () => ({
  listInstalledSkills: () => {
    throw new Error("skill catalog unreadable");
  },
}));

const { collectInstalledInventory } = await import("../installed-inventory.js");

describe("collectInstalledInventory — section failure", () => {
  test("records a skills error instead of a silently-empty section", async () => {
    const inventory = await collectInstalledInventory();

    expect(inventory.skills).toEqual([]);
    expect(inventory.errors?.skills).toContain("skill catalog unreadable");
    // The plugins half is independent and still collected.
    expect(Array.isArray(inventory.plugins)).toBe(true);
    expect(inventory.errors?.plugins).toBeUndefined();
  });
});
