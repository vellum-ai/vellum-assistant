import { describe, expect, test } from "bun:test";

import { buildPkbReminder } from "./pkb-reminder-builder.js";

// Byte-for-byte fixture of the default (non-relaxed) PKB reminder. Asserted
// verbatim so that any future edit to the BODY text is caught by tests.
const BASE_REMINDER_DEFAULT =
  "<system_reminder>" +
  "\n**CRITICAL:** Call `remember` this turn for anything concrete the user said — facts, preferences, plans, names, dates, decisions, corrections, felt moments. Default to remembering; skip only obvious noise. This should be your most frequently used tool." +
  "\nIf you're unsure about something that may live in the workspace — past decisions, prior conversations, files — use `recall` before asking or guessing." +
  "\n</system_reminder>";

// Byte-for-byte fixture of the relaxed PKB reminder used when the
// `memory-retrospective` feature flag is on.
const BASE_REMINDER_RELAXED =
  "<system_reminder>" +
  "\nStay present in this conversation. Use `remember` when something feels worth pausing to mark — corrections (highest priority), plans, decisions, felt moments. You don't have to capture everything in the moment — a retrospective pass reviews this conversation in the background and saves what you didn't capture." +
  "\nIf you're unsure about something that may live in the workspace — past decisions, prior conversations, files — use `recall` before asking or guessing." +
  "\n</system_reminder>";

describe("buildPkbReminder — default body (relaxed=false)", () => {
  test("empty hints returns exact base reminder byte-for-byte", () => {
    expect(buildPkbReminder([], false)).toBe(BASE_REMINDER_DEFAULT);
  });

  test("single hint renders one bullet with no duplicates or trailing blank line", () => {
    const out = buildPkbReminder(["projects/alpha.md"], false);
    const expected =
      "<system_reminder>" +
      "\n**CRITICAL:** Call `remember` this turn for anything concrete the user said — facts, preferences, plans, names, dates, decisions, corrections, felt moments. Default to remembering; skip only obvious noise. This should be your most frequently used tool." +
      "\nIf you're unsure about something that may live in the workspace — past decisions, prior conversations, files — use `recall` before asking or guessing." +
      "\nBased on the current context, these files look especially relevant:" +
      "\n- projects/alpha.md" +
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
    const out = buildPkbReminder(hints, false);
    const expected =
      "<system_reminder>" +
      "\n**CRITICAL:** Call `remember` this turn for anything concrete the user said — facts, preferences, plans, names, dates, decisions, corrections, felt moments. Default to remembering; skip only obvious noise. This should be your most frequently used tool." +
      "\nIf you're unsure about something that may live in the workspace — past decisions, prior conversations, files — use `recall` before asking or guessing." +
      "\nBased on the current context, these files look especially relevant:" +
      "\n- a.md" +
      "\n- sub/b.md" +
      "\n- c/d/e.md" +
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
    const out = buildPkbReminder(hints, false);
    expect(out).toContain("- weird<name>.md");
    expect(out).toContain("- foo&bar.md");
    // Ensure no HTML-style escaping happened.
    expect(out).not.toContain("&lt;");
    expect(out).not.toContain("&amp;");
  });
});

describe("buildPkbReminder — relaxed body (relaxed=true)", () => {
  test("empty hints returns the relaxed base reminder byte-for-byte", () => {
    expect(buildPkbReminder([], true)).toBe(BASE_REMINDER_RELAXED);
  });

  test("relaxed BODY does NOT contain the default high-pressure phrasing", () => {
    const out = buildPkbReminder([], true);
    expect(out).not.toContain("**CRITICAL:**");
    expect(out).not.toContain("most frequently used tool");
    expect(out).not.toContain("Default to remembering");
  });

  test("relaxed BODY mentions the retrospective backstop framing", () => {
    const out = buildPkbReminder([], true);
    expect(out).toContain("Stay present");
    expect(out).toContain("retrospective pass");
  });

  test("hints render below the relaxed body in the same shape as default", () => {
    const out = buildPkbReminder(["projects/alpha.md"], true);
    expect(out).toContain("- projects/alpha.md");
    expect(out).toContain(
      "Based on the current context, these files look especially relevant:",
    );
    // Should still close cleanly with no double newline before the tag.
    expect(out.includes("\n\n</system_reminder>")).toBe(false);
  });
});

describe("buildPkbReminder — relaxed vs default differ", () => {
  test("the two BODY variants are NOT byte-identical", () => {
    expect(buildPkbReminder([], false)).not.toBe(buildPkbReminder([], true));
  });
});
