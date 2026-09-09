import { describe, expect, test } from "bun:test";

import { formatLocale } from "@/i18n";
import { stubHostLanguage } from "@/i18n/host-language.test-helper";
import {
  formatCaptureTime,
  formatCompactLocalDate,
  formatFriendlyDate,
  formatFullLocalDate,
} from "@/utils/format-date";

/**
 * Assertions are written against the runtime's own locale data rather than a
 * hardcoded "Aug 5, 11:42 AM", so they hold wherever the suite runs. What they
 * pin is the composition: the friendly date, a comma, and the local time.
 */
function localTime(date: Date, locale: string = formatLocale()): string {
  return date.toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
  });
}

describe("formatCompactLocalDate", () => {
  test("pairs the friendly date with the local time", () => {
    const date = new Date(2026, 7, 5, 11, 42);

    expect(formatCompactLocalDate(date.toISOString())).toBe(
      `${formatFriendlyDate(date)}, ${localTime(date)}`,
    );
  });

  test("leaves the year off a date inside the current one", () => {
    const currentYear = new Date().getFullYear();
    const date = new Date(currentYear, 0, 15, 9, 14);

    expect(formatCompactLocalDate(date.toISOString())).not.toContain(
      String(currentYear),
    );
  });

  test("carries the year once the date falls outside the current one", () => {
    const date = new Date(2001, 0, 15, 9, 14);

    expect(formatCompactLocalDate(date.toISOString())).toContain("2001");
  });

  test("stays shorter than the full local date it condenses", () => {
    const iso = new Date(2026, 7, 5, 11, 42).toISOString();

    expect(formatCompactLocalDate(iso).length).toBeLessThan(
      formatFullLocalDate(iso).length,
    );
  });

  test("renders nothing for a missing timestamp", () => {
    expect(formatCompactLocalDate(null)).toBe("");
    expect(formatCompactLocalDate(undefined)).toBe("");
    expect(formatCompactLocalDate("")).toBe("");
  });

  test("formats date and time together in the locale it is given", () => {
    const date = new Date(2001, 0, 15, 13, 42);
    const iso = date.toISOString();

    // Both halves move, so the label cannot carry an app-locale date beside a
    // browser-locale time.
    expect(formatCompactLocalDate(iso, "ru")).toBe(
      `${formatFriendlyDate(date, { locale: "ru" })}, ${localTime(date, "ru")}`,
    );
    expect(formatCompactLocalDate(iso, "ru")).not.toBe(
      formatCompactLocalDate(iso, "en"),
    );
  });
});

describe("formatFullLocalDate", () => {
  test("formats in the locale it is given", () => {
    const iso = new Date(2001, 0, 15, 13, 42).toISOString();

    expect(formatFullLocalDate(iso, "ru")).toBe(
      new Date(iso).toLocaleString("ru", {
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }),
    );
    expect(formatFullLocalDate(iso, "ru")).not.toBe(
      formatFullLocalDate(iso, "en"),
    );
  });

  test("renders nothing for a missing timestamp", () => {
    expect(formatFullLocalDate(null)).toBe("");
    expect(formatFullLocalDate(undefined)).toBe("");
  });
});

describe("formatCaptureTime", () => {
  test("gives the time of day for a capture made today", () => {
    const capturedAt = new Date().setHours(9, 41, 0, 0);

    expect(formatCaptureTime(capturedAt, "en")).toBe(
      new Date(capturedAt).toLocaleTimeString("en", {
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });

  test("tells two captures from one session apart", () => {
    const morning = new Date().setHours(9, 41, 0, 0);
    const evening = new Date().setHours(18, 12, 0, 0);

    expect(formatCaptureTime(morning, "en")).not.toBe(
      formatCaptureTime(evening, "en"),
    );
  });

  test("falls back to the friendly date for an older capture", () => {
    const capturedAt = new Date(2001, 0, 15, 9, 14).getTime();

    expect(formatCaptureTime(capturedAt, "en")).toBe(
      formatFriendlyDate(new Date(capturedAt), { locale: "en" }),
    );
    expect(formatCaptureTime(capturedAt, "en")).toContain("2001");
  });

  test("formats in the locale it is given", () => {
    const capturedAt = new Date(2001, 0, 15, 9, 14).getTime();

    expect(formatCaptureTime(capturedAt, "ru")).not.toBe(
      formatCaptureTime(capturedAt, "en"),
    );
  });
});

describe("the default locale", () => {
  test("keeps the host's region while the app language stays English", () => {
    const restore = stubHostLanguage("en-GB");
    try {
      const date = new Date(2001, 0, 15, 13, 42);

      // en-GB is day-first and 24-hour, so both halves move away from the
      // bare `en` the app runs its copy in.
      expect(formatCompactLocalDate(date.toISOString())).toBe(
        `${formatFriendlyDate(date, { locale: "en-GB" })}, ${localTime(date, "en-GB")}`,
      );
    } finally {
      restore();
    }
  });

  test("falls back to the app language when the host speaks another", () => {
    const restore = stubHostLanguage("de-DE");
    try {
      const date = new Date(2001, 0, 15, 13, 42);

      expect(formatCompactLocalDate(date.toISOString())).toBe(
        `${formatFriendlyDate(date, { locale: "en" })}, ${localTime(date, "en")}`,
      );
    } finally {
      restore();
    }
  });
});
