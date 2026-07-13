import { describe, expect, test } from "bun:test";

import {
  INTERACTIVE_TARGET_SELECTOR,
  isInteractiveTarget,
} from "@/utils/interactive-target";

describe("isInteractiveTarget", () => {
  test("returns true for interactive elements", () => {
    for (const tag of ["a", "button", "input", "textarea", "select"]) {
      expect(isInteractiveTarget(document.createElement(tag))).toBe(true);
    }
  });

  test('returns true for [role="button"]', () => {
    const el = document.createElement("div");
    el.setAttribute("role", "button");
    expect(isInteractiveTarget(el)).toBe(true);
  });

  test("returns true when an ancestor is interactive", () => {
    const link = document.createElement("a");
    const span = document.createElement("span");
    link.appendChild(span);
    expect(isInteractiveTarget(span)).toBe(true);
  });

  test("returns false for non-interactive elements", () => {
    expect(isInteractiveTarget(document.createElement("div"))).toBe(false);
    expect(isInteractiveTarget(document.createElement("span"))).toBe(false);
  });

  test("returns false for null", () => {
    expect(isInteractiveTarget(null)).toBe(false);
  });

  test("selector covers the documented interactive controls", () => {
    expect(INTERACTIVE_TARGET_SELECTOR).toContain("button");
    expect(INTERACTIVE_TARGET_SELECTOR).toContain('[role="button"]');
  });
});
