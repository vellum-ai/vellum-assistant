import { describe, expect, test } from "bun:test";

import { buildPkbReminder } from "./pkb-reminder-builder.js";

// Byte-for-byte fixture of the base PKB reminder.
const BASE_REMINDER =
  "<system_reminder>" +
  "\nRead any unread Personal Knowledge Base files that might be even partially relevant to this conversation" +
  "\nUse `remember` for anything you learn immediately" +
  "\nIf you're unsure about something that may have an answer in your workspace, use `recall` to try to find it before asking or making assumptions" +
  "\n</system_reminder>";

describe("buildPkbReminder", () => {
  test("empty hints returns exact base reminder byte-for-byte", () => {
    expect(buildPkbReminder([])).toBe(BASE_REMINDER);
  });

  test("single hint renders one bullet with no duplicates or trailing blank line", () => {
    const out = buildPkbReminder(["projects/alpha.md"]);
    const expected =
      "<system_reminder>" +
      "\nRead any unread Personal Knowledge Base files that might be even partially relevant to this conversation." +
      "\nBased on the current context, these files look especially relevant:" +
      "\n- projects/alpha.md" +
      "\nUse `remember` for anything you learn immediately" +
      "\nIf you're unsure about something that may have an answer in your workspace, use `recall` to try to find it before asking or making assumptions" +
      "\n</system_reminder>";
    expect(out).toBe(expected);

    // Exactly one bullet.
    const bulletCount = (out.match(/^- /gm) ?? []).length;
    expect(bulletCount).toBe(1);

    // No blank line before closing tag.
    expect(out.includes("\n\n</system_reminder>")).toBe(false);
  });

  test("three hints render all three in order", () => {
    const hints = ["a.md", "sub/b.md", "c/d/e.md"];
    const out = buildPkbReminder(hints);
    const expected =
      "<system_reminder>" +
      "\nRead any unread Personal Knowledge Base files that might be even partially relevant to this conversation." +
      "\nBased on the current context, these files look especially relevant:" +
      "\n- a.md" +
      "\n- sub/b.md" +
      "\n- c/d/e.md" +
      "\nUse `remember` for anything you learn immediately" +
      "\nIf you're unsure about something that may have an answer in your workspace, use `recall` to try to find it before asking or making assumptions" +
      "\n</system_reminder>";
    expect(out).toBe(expected);

    // Order check — each should appear after the previous.
    const idxA = out.indexOf("- a.md");
    const idxB = out.indexOf("- sub/b.md");
    const idxC = out.indexOf("- c/d/e.md");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxB);
  });

  test("hints with special chars (< and &) are emitted verbatim (no escaping)", () => {
    const hints = ["weird<name>.md", "foo&bar.md"];
    const out = buildPkbReminder(hints);
    expect(out).toContain("- weird<name>.md");
    expect(out).toContain("- foo&bar.md");
    // Ensure no HTML-style escaping happened.
    expect(out).not.toContain("&lt;");
    expect(out).not.toContain("&amp;");
  });
});
