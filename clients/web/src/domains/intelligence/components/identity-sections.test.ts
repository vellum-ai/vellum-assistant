/**
 * The overview's drill-down section list: a stable order, with nothing gated
 * on backend capability or platform. Whatever the backend reports and
 * whatever shell the app runs in, the list is the same, so an assistant that
 * can't draw the memory concept graph still gets a Memory card leading into
 * the tab that explains it, and a phone user reaches every section.
 */
import { describe, expect, test } from "bun:test";

import { buildIdentitySections } from "./identity-sections";

const keys = () => buildIdentitySections().map((s) => s.key);

describe("buildIdentitySections", () => {
  test("includes every section, in order", () => {
    expect(keys()).toEqual([
      "personality",
      "schedules",
      "superpowers",
      "memory",
      "library",
      "workspace",
      "contacts",
      "channels",
    ]);
  });

  test("never hides Memory, whatever the backend reports", () => {
    expect(keys()).toContain("memory");
  });

  test("every section carries a label, description and path", () => {
    for (const section of buildIdentitySections()) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.description.length).toBeGreaterThan(0);
      expect(section.to.startsWith("/")).toBe(true);
    }
  });
});
