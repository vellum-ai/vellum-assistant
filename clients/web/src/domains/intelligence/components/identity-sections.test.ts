/**
 * The overview's drill-down section list: a stable order, with nothing gated
 * on backend capability. Whatever the backend reports, the list is the same,
 * so an assistant that can't draw the memory concept graph still gets a
 * Memory card leading into the tab that explains it. The one subtraction is
 * the native mobile shell, which omits the two sections that are desk work
 * (Memory and Workspace) and keeps everything a phone user needs to reach.
 */
import { describe, expect, test } from "bun:test";

import { buildIdentitySections } from "./identity-sections";

const keys = (isNativeMobile = false) =>
  buildIdentitySections({ isNativeMobile }).map((s) => s.key);

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

  test("defaults to the full list when no options are passed", () => {
    expect(buildIdentitySections().map((s) => s.key)).toEqual(keys());
  });

  test("never hides Memory on the surfaces that show it, whatever the backend reports", () => {
    expect(keys()).toContain("memory");
  });

  test("native mobile drops Memory and Workspace, and nothing else", () => {
    expect(keys(true)).toEqual([
      "personality",
      "schedules",
      "superpowers",
      "library",
      "contacts",
      "channels",
    ]);
  });

  // Checking who the assistant knows and where it listens is mobile work,
  // so the native mobile filter must never drop Contacts or Channels
  // (LUM-3136).
  test.each(["contacts", "channels"])(
    "keeps %s on every platform, phone included",
    (key) => {
      expect(keys(true)).toContain(key);
      expect(keys(false)).toContain(key);
    },
  );

  test("native mobile keeps the remaining sections in their desktop order", () => {
    const nativeMobile = keys(true);
    const desktopOrder = keys().filter((key) => nativeMobile.includes(key));
    expect(nativeMobile).toEqual(desktopOrder);
  });

  test("every section carries a label, description and path", () => {
    for (const isNativeMobile of [false, true]) {
      for (const section of buildIdentitySections({ isNativeMobile })) {
        expect(section.label.length).toBeGreaterThan(0);
        expect(section.description.length).toBeGreaterThan(0);
        expect(section.to.startsWith("/")).toBe(true);
      }
    }
  });
});
