/**
 * Tests for `buildReadToggle`.
 *
 * The glyph names the item's current state: a sealed envelope for unread, an
 * opened one for read. Comparing against the icon components themselves rather
 * than rendering them keeps the check on that mapping.
 */

import { describe, expect, test } from "bun:test";
import { Mail, MailOpen } from "lucide-react";

import { fixedT } from "@/i18n";

import { buildReadToggle } from "./read-toggle";

// The builder takes a namespace-bound `t`, the same thing
// `useTranslation("home")` hands its component callers.
const t = fixedT("home");

describe("buildReadToggle", () => {
  test("an unread item shows a sealed envelope and offers to mark it read", () => {
    const toggle = buildReadToggle(true, t);

    expect(toggle.icon).toBe(Mail);
    expect(toggle.icon).not.toBe(MailOpen);
    expect(toggle.label).toBe("Mark as read");
    expect(toggle.nextStatus).toBe("seen");
  });

  test("a read item shows an opened envelope and offers to mark it unread", () => {
    const toggle = buildReadToggle(false, t);

    expect(toggle.icon).toBe(MailOpen);
    expect(toggle.icon).not.toBe(Mail);
    expect(toggle.label).toBe("Mark as unread");
    expect(toggle.nextStatus).toBe("new");
  });
});
