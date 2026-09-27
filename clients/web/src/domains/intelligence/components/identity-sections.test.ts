/**
 * The overview's drill-down section list: a stable order, with nothing gated
 * on backend capability or platform. Whatever the backend reports and
 * whatever shell the app runs in, the list is the same, so a phone user
 * reaches every section. Email is the one addition, and only where the
 * inbox exists.
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
      "library",
      "workspace",
      "contacts",
      "channels",
    ]);
  });

  test("draws Email after Channels only when asked, carrying the lock", () => {
    const withEmail = buildIdentitySections({ email: { locked: true } });
    const emailIndex = withEmail.findIndex((s) => s.key === "email");
    expect(emailIndex).toBe(
      withEmail.findIndex((s) => s.key === "channels") + 1,
    );
    expect(withEmail[emailIndex]?.locked).toBe(true);
    expect(withEmail[emailIndex]?.to).toBe("/assistant/inbox");
    expect(
      buildIdentitySections({ email: { locked: false } }).find(
        (s) => s.key === "email",
      )?.locked,
    ).toBe(false);
  });

  test("every section carries a label, description and path", () => {
    for (const section of buildIdentitySections()) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.description.length).toBeGreaterThan(0);
      expect(section.to.startsWith("/")).toBe(true);
    }
  });
});
