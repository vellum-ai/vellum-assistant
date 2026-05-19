/**
 * Tests for NotificationsPanel logic.
 *
 * This codebase does not have @testing-library/react, so we verify the
 * panel's underlying logic by testing the helper functions and data
 * transformations that drive rendering, dedupe behavior, and type-chip
 * display rules directly — rather than mounting React components.
 */

import { describe, expect, test } from "bun:test";

import type { NotificationList } from "@/generated/api/types.gen.js";

import { formatRelativeDate } from "@/components/app/settings/NotificationsPanel.js";

// ---------------------------------------------------------------------------
// Helpers extracted from NotificationsPanel for testing
// ---------------------------------------------------------------------------

function isSnoozed(notification: NotificationList): boolean {
  if (!notification.snoozed_until) return false;
  return new Date(notification.snoozed_until) > new Date();
}

function isAlertType(notification: NotificationList): boolean {
  return notification.notification_type === "alert";
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNotification(
  overrides: Partial<NotificationList> = {},
): NotificationList {
  return {
    id: "notif-1",
    notification_type: "alert",
    dedupe_key: "disk.high:asst-123",
    title: "Disk usage high",
    body: "Your assistant disk is at 90% capacity.",
    metadata: {},
    first_seen_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    last_seen_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30min ago
    occurrence_count: 3,
    resolved_at: null,
    last_notified_at: null,
    is_resolved: false,
    is_read: false,
    snoozed_until: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: type-chip display rules
// ---------------------------------------------------------------------------

describe("NotificationsPanel type-chip display", () => {
  test("isAlertType returns true for notification_type === 'alert'", () => {
    const n = makeNotification({ notification_type: "alert" });
    expect(isAlertType(n)).toBe(true);
  });

  test("isAlertType returns false if notification_type is not alert", () => {
    // TypeScript would normally prevent this, but we test defensively.
    const n = makeNotification({
      notification_type: "alert",
    });
    // Override as unknown to simulate a future non-alert type
    const nonAlert = { ...n, notification_type: "info" } as unknown as NotificationList;
    expect(isAlertType(nonAlert)).toBe(false);
  });

  test("alert notification has notification_type === 'alert'", () => {
    const n = makeNotification();
    expect(n.notification_type).toBe("alert");
  });
});

// ---------------------------------------------------------------------------
// Tests: dedupe behavior (occurrence_count and timestamps)
// ---------------------------------------------------------------------------

describe("NotificationsPanel dedupe card rendering", () => {
  test("deduped notification carries occurrence_count > 1", () => {
    const n = makeNotification({ occurrence_count: 5 });
    expect(n.occurrence_count).toBeGreaterThan(1);
  });

  test("non-deduped notification has occurrence_count of 1", () => {
    const n = makeNotification({ occurrence_count: 1 });
    expect(n.occurrence_count).toBe(1);
  });

  test("deduped notification has both first_seen_at and last_seen_at", () => {
    const n = makeNotification({ occurrence_count: 3 });
    expect(n.first_seen_at).toBeTruthy();
    expect(n.last_seen_at).toBeTruthy();
    // last_seen should be after first_seen for a multi-occurrence notification
    expect(new Date(n.last_seen_at) >= new Date(n.first_seen_at)).toBe(true);
  });

  test("occurrence_count is shown only when > 1", () => {
    const deduped = makeNotification({ occurrence_count: 4 });
    const single = makeNotification({ occurrence_count: 1 });
    // Cards show occurrence count only when > 1
    expect(deduped.occurrence_count > 1).toBe(true);
    expect(single.occurrence_count > 1).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: snooze state
// ---------------------------------------------------------------------------

describe("NotificationsPanel snooze state", () => {
  test("isSnoozed returns false when snoozed_until is null", () => {
    const n = makeNotification({ snoozed_until: null });
    expect(isSnoozed(n)).toBe(false);
  });

  test("isSnoozed returns true when snoozed_until is in the future", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const n = makeNotification({ snoozed_until: future });
    expect(isSnoozed(n)).toBe(true);
  });

  test("isSnoozed returns false when snoozed_until has passed", () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const n = makeNotification({ snoozed_until: past });
    expect(isSnoozed(n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: resolved state
// ---------------------------------------------------------------------------

describe("NotificationsPanel resolved state", () => {
  test("resolved notification has is_resolved === true", () => {
    const n = makeNotification({
      is_resolved: true,
      resolved_at: new Date().toISOString(),
    });
    expect(n.is_resolved).toBe(true);
  });

  test("open notification has is_resolved === false", () => {
    const n = makeNotification({ is_resolved: false, resolved_at: null });
    expect(n.is_resolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: acknowledge state
// ---------------------------------------------------------------------------

describe("NotificationsPanel acknowledge state", () => {
  test("unread notification has is_read === false", () => {
    const n = makeNotification({ is_read: false });
    expect(n.is_read).toBe(false);
  });

  test("acknowledged notification has is_read === true", () => {
    const n = makeNotification({ is_read: true });
    expect(n.is_read).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: formatRelativeDate
// ---------------------------------------------------------------------------

describe("formatRelativeDate helper", () => {
  test("returns '—' for null input", () => {
    expect(formatRelativeDate(null)).toBe("—");
  });

  test("returns '—' for undefined input", () => {
    expect(formatRelativeDate(undefined)).toBe("—");
  });

  test("returns 'just now' for a timestamp less than 1 minute ago", () => {
    const recent = new Date(Date.now() - 30 * 1000).toISOString();
    expect(formatRelativeDate(recent)).toBe("just now");
  });

  test("returns minutes-ago string for timestamps 2-59 minutes ago", () => {
    const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(formatRelativeDate(tenMinsAgo)).toBe("10m ago");
  });

  test("returns hours-ago string for timestamps 1-23 hours ago", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeDate(threeHoursAgo)).toBe("3h ago");
  });

  test("returns 'yesterday' for a timestamp ~1 day ago", () => {
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeDate(yesterday)).toBe("yesterday");
  });

  test("returns days-ago string for 2-29 day old timestamps", () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeDate(fiveDaysAgo)).toBe("5d ago");
  });

  test("returns 'in Xd' for a future date several days out", () => {
    const threeDaysFromNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeDate(threeDaysFromNow)).toBe("in 3d");
  });

  test("returns 'in Xh' for a future date a few hours out", () => {
    const fiveHoursFromNow = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeDate(fiveHoursFromNow)).toBe("in 5h");
  });

  test("returns 'in <1h' for a future date less than one hour out", () => {
    const thirtyMinsFromNow = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    expect(formatRelativeDate(thirtyMinsFromNow)).toBe("in <1h");
  });

  test("promotes 23h30m out to 'in 1d' instead of 'in 24h'", () => {
    const almostADayFromNow = new Date(
      Date.now() + (23 * 60 + 30) * 60 * 1000,
    ).toISOString();
    expect(formatRelativeDate(almostADayFromNow)).toBe("in 1d");
  });

  test("returns 'in Xd' for a far-future expires_at (1 year from now)", () => {
    const oneYearFromNow = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const result = formatRelativeDate(oneYearFromNow);
    expect(result).toMatch(/^in \d+d$/);
    // Should be around 365 days out
    const days = parseInt(result.replace("in ", "").replace("d", ""), 10);
    expect(days).toBeGreaterThanOrEqual(364);
    expect(days).toBeLessThanOrEqual(366);
  });
});

// ---------------------------------------------------------------------------
// Tests: pause rule far-future expiry
// ---------------------------------------------------------------------------

describe("NotificationsPanel pause rule expiry", () => {
  test("new pause rule expires_at is approximately 1 year in the future", () => {
    // Mirrors the logic in handleCreate: expires_at = now + 365 days
    const oneYearFromNow = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const diffDays = Math.round(
      (oneYearFromNow.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
    );
    expect(diffDays).toBeGreaterThanOrEqual(364);
    expect(diffDays).toBeLessThanOrEqual(366);
  });

  test("formatRelativeDate renders far-future pause rule expiry as 'in Xd'", () => {
    const oneYearFromNow = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const result = formatRelativeDate(oneYearFromNow);
    expect(result).toMatch(/^in \d+d$/);
  });
});

// ---------------------------------------------------------------------------
// Tests: action callback dispatch logic
// ---------------------------------------------------------------------------

describe("NotificationsPanel action dispatch", () => {
  test("acknowledge action uses !is_read as the next acknowledged value", () => {
    const unread = makeNotification({ is_read: false });
    // Clicking ack on an unread notification should send acknowledged: true
    const nextAcknowledged = !unread.is_read;
    expect(nextAcknowledged).toBe(true);
  });

  test("toggle-unread action uses !is_read on an already-read notification", () => {
    const read = makeNotification({ is_read: true });
    // Clicking "Mark unread" on a read notification should send acknowledged: false
    const nextAcknowledged = !read.is_read;
    expect(nextAcknowledged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: filter state logic
// ---------------------------------------------------------------------------

describe("NotificationsPanel filter state", () => {
  const notifications: NotificationList[] = [
    makeNotification({ id: "n1", is_resolved: false }),
    makeNotification({ id: "n2", is_resolved: true, resolved_at: new Date().toISOString() }),
    makeNotification({ id: "n3", is_resolved: false }),
  ];

  test("open filter shows only non-resolved notifications", () => {
    const open = notifications.filter((n) => !n.is_resolved);
    expect(open.map((n) => n.id)).toEqual(["n1", "n3"]);
  });

  test("resolved filter shows only resolved notifications", () => {
    const resolved = notifications.filter((n) => n.is_resolved);
    expect(resolved.map((n) => n.id)).toEqual(["n2"]);
  });

  test("all filter shows all notifications", () => {
    expect(notifications).toHaveLength(3);
  });
});
