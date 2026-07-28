/**
 * The overview's drill-down section list: every section is unconditional, in a
 * stable order. Memory used to be gated on memory-concept-graph availability
 * and would vanish from the mosaic; it is now always present, and the Memory
 * tab itself explains an unavailable graph.
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

  test("never hides Memory — the card is the way into the Memory tab", () => {
    expect(keys()).toContain("memory");
  });

  test("always includes Channels", () => {
    expect(keys()).toContain("channels");
  });

  test("every section carries a label, description and path", () => {
    for (const section of buildIdentitySections()) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.description.length).toBeGreaterThan(0);
      expect(section.to.startsWith("/")).toBe(true);
    }
  });
});
