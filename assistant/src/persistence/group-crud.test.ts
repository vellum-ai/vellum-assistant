import { describe, expect, test } from "bun:test";

import { initializeDb } from "./db-init.js";
import {
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  updateGroup,
} from "./group-crud.js";

await initializeDb();

describe("group-crud icon field", () => {
  test("createGroup persists an icon and getGroup returns it", () => {
    const group = createGroup("With icon", "rocket");
    try {
      expect(group.icon).toBe("rocket");
      expect(getGroup(group.id)?.icon).toBe("rocket");
    } finally {
      deleteGroup(group.id);
    }
  });

  test("createGroup without an icon stores null", () => {
    const group = createGroup("No icon");
    try {
      expect(group.icon).toBeNull();
      expect(getGroup(group.id)?.icon).toBeNull();
    } finally {
      deleteGroup(group.id);
    }
  });

  test("updateGroup sets, preserves, and clears the icon", () => {
    const group = createGroup("Mutable");
    try {
      expect(updateGroup(group.id, { icon: "star" })?.icon).toBe("star");
      // A name-only update leaves the icon untouched.
      const renamed = updateGroup(group.id, { name: "Renamed" });
      expect(renamed?.name).toBe("Renamed");
      expect(renamed?.icon).toBe("star");
      // Explicit null clears it.
      expect(updateGroup(group.id, { icon: null })?.icon).toBeNull();
    } finally {
      deleteGroup(group.id);
    }
  });

  test("listGroups carries the icon column", () => {
    const group = createGroup("Listed", "heart");
    try {
      const listed = listGroups().find((g) => g.id === group.id);
      expect(listed?.icon).toBe("heart");
    } finally {
      deleteGroup(group.id);
    }
  });
});
