/**
 * Tests for SystemEventsTab helper functions.
 *
 * This codebase does not have @testing-library/react, so we verify the
 * tab's helper functions and data transformations directly — rather than
 * mounting React components.
 */

import { describe, expect, test } from "bun:test";

import type { EventStatusEnum, SystemEventTypeEnum } from "@/generated/api/types.gen.js";

import {
  formatAbsoluteTimestamp,
  formatEventStatus,
  formatEventType,
  isFailureStatus,
  isSuccessStatus,
} from "@/components/app/pages/LogsAndUsage/system-events-tab.js";

// ---------------------------------------------------------------------------
// Tests: formatEventType
// ---------------------------------------------------------------------------

describe("formatEventType", () => {
  const cases: [SystemEventTypeEnum, string][] = [
    ["lifecycle", "Lifecycle"],
    ["upgrade", "Upgrade"],
    ["rollback", "Rollback"],
    ["crash", "Crash"],
    ["idle_sleep", "Idle Sleep"],
    ["wake", "Wake"],
    ["other", "Other"],
  ];

  for (const [type, expected] of cases) {
    test(`formats ${type} as "${expected}"`, () => {
      expect(formatEventType(type)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Tests: formatEventStatus
// ---------------------------------------------------------------------------

describe("formatEventStatus", () => {
  const cases: [EventStatusEnum, string][] = [
    ["started", "Started"],
    ["succeeded", "Succeeded"],
    ["failed", "Failed"],
    ["in_progress", "In Progress"],
  ];

  for (const [status, expected] of cases) {
    test(`formats ${status} as "${expected}"`, () => {
      expect(formatEventStatus(status)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Tests: isSuccessStatus / isFailureStatus
// ---------------------------------------------------------------------------

describe("isSuccessStatus", () => {
  test("returns true for succeeded", () => {
    expect(isSuccessStatus("succeeded")).toBe(true);
  });

  test("returns false for non-success statuses", () => {
    const nonSuccess: EventStatusEnum[] = ["started", "failed", "in_progress"];
    for (const s of nonSuccess) {
      expect(isSuccessStatus(s)).toBe(false);
    }
  });
});

describe("isFailureStatus", () => {
  test("returns true for failed", () => {
    expect(isFailureStatus("failed")).toBe(true);
  });

  test("returns false for non-failure statuses", () => {
    const nonFail: EventStatusEnum[] = ["started", "succeeded", "in_progress"];
    for (const s of nonFail) {
      expect(isFailureStatus(s)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: formatAbsoluteTimestamp
// ---------------------------------------------------------------------------

describe("formatAbsoluteTimestamp", () => {
  test("returns a non-empty string for a valid ISO timestamp", () => {
    const result = formatAbsoluteTimestamp("2026-01-15T10:30:00Z");
    expect(result.length).toBeGreaterThan(0);
  });

  test("includes at least the year from the timestamp", () => {
    const result = formatAbsoluteTimestamp("2026-01-15T10:30:00Z");
    expect(result).toContain("2026");
  });
});

// ---------------------------------------------------------------------------
// Tests: sidebar navigation (sanity check that system-events is no longer in settings)
// ---------------------------------------------------------------------------

import { routes } from "@/lib/routes.js";
import { PANEL_IDS, SETTINGS_SIDEBAR } from "@/lib/settings/navigation.js";

describe("SETTINGS_SIDEBAR does not include system-events", () => {
  test("PANEL_IDS excludes assistant-system-events", () => {
    expect((PANEL_IDS as readonly string[]).includes("assistant-system-events")).toBe(false);
  });

  test("sidebar does not include a system-events item", () => {
    const hrefs = SETTINGS_SIDEBAR.map((item) => item.href);
    expect(hrefs).not.toContain(routes.settings.systemEvents);
  });
});
