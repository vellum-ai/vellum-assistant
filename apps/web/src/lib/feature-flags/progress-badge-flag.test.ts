import { afterEach, describe, expect, test } from "bun:test";

import {
  getProgressBadgeVariant,
  isProgressBadgeEnabled,
} from "./progress-badge-flag";

const STORAGE_KEY = "vellum:debug:useProgressBadge";

describe("progress-badge-flag", () => {
  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  test("no override → off", () => {
    expect(getProgressBadgeVariant()).toBeNull();
    expect(isProgressBadgeEnabled()).toBe(false);
  });

  test("legacy \"true\" → dots variant, enabled", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    expect(getProgressBadgeVariant()).toBe("dots");
    expect(isProgressBadgeEnabled()).toBe(true);
  });

  test("\"gradient\" → gradient variant, enabled", () => {
    localStorage.setItem(STORAGE_KEY, "gradient");
    expect(getProgressBadgeVariant()).toBe("gradient");
    expect(isProgressBadgeEnabled()).toBe(true);
  });

  test("unrecognized value → off", () => {
    localStorage.setItem(STORAGE_KEY, "false");
    expect(getProgressBadgeVariant()).toBeNull();
    expect(isProgressBadgeEnabled()).toBe(false);
  });
});
