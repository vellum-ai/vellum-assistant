import { describe, expect, test } from "bun:test";

import { formatLocale } from "@/i18n";
import { stubHostLanguage } from "@/i18n/host-language.test-helper";
import {
  formatCaptureTime,
  formatCompactLocalDate,
  formatFriendlyDate,
  formatFullLocalDate,
  formatRelativeDate,
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

/** The options {@link formatFullLocalDate} formats its timestamp with. */
const FULL_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "long",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};

/** Runs `assert` with the host reporting `tag`, then puts the host back. */
function underHostLanguage(tag: string, assert: () => void): void {
  const restore = stubHostLanguage(tag);
  try {
    assert();
  } finally {
    restore();
  }
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
});

describe("formatFullLocalDate", () => {
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

/**
 * Every formatter reads {@link formatLocale} when it is not handed a locale,
 * so each one is checked against the host's region: en-GB is day-first and
 * 24-hour, which moves it away from the bare `en` the app runs its copy in.
 */
describe("the default locale", () => {
  test("formatCaptureTime tells the time in the host's region", () => {
    underHostLanguage("en-GB", () => {
      const capturedAt = new Date().setHours(13, 42, 0, 0);

      expect(formatCaptureTime(capturedAt)).toBe(
        formatCaptureTime(capturedAt, "en-GB"),
      );
      expect(formatCaptureTime(capturedAt)).not.toBe(
        formatCaptureTime(capturedAt, "en"),
      );
    });
  });

  test("formatFriendlyDate orders the date the host's region does", () => {
    underHostLanguage("en-GB", () => {
      const date = new Date(2001, 0, 15);

      expect(formatFriendlyDate(date)).toBe(
        formatFriendlyDate(date, { locale: "en-GB" }),
      );
      expect(formatFriendlyDate(date)).not.toBe(
        formatFriendlyDate(date, { locale: "en" }),
      );
    });
  });

  test("formatRelativeDate falls back to a date in the host's region", () => {
    underHostLanguage("en-GB", () => {
      const date = new Date(2001, 0, 15, 9, 14);

      expect(formatRelativeDate(date.toISOString())).toBe(
        date.toLocaleDateString("en-GB"),
      );
      expect(formatRelativeDate(date.toISOString())).not.toBe(
        date.toLocaleDateString("en"),
      );
    });
  });

  test("formatCompactLocalDate moves both of its halves together", () => {
    underHostLanguage("en-GB", () => {
      const date = new Date(2001, 0, 15, 13, 42);

      // One label cannot carry an app-locale date beside a host-locale time.
      expect(formatCompactLocalDate(date.toISOString())).toBe(
        `${formatFriendlyDate(date, { locale: "en-GB" })}, ${localTime(date, "en-GB")}`,
      );
      expect(formatCompactLocalDate(date.toISOString())).not.toBe(
        `${formatFriendlyDate(date, { locale: "en" })}, ${localTime(date, "en")}`,
      );
    });
  });

  test("formatFullLocalDate spells the month and names the zone", () => {
    underHostLanguage("en-GB", () => {
      const iso = new Date(2001, 0, 15, 13, 42).toISOString();

      expect(formatFullLocalDate(iso)).toBe(
        new Date(iso).toLocaleString("en-GB", FULL_DATE_OPTIONS),
      );
      expect(formatFullLocalDate(iso)).not.toBe(
        new Date(iso).toLocaleString("en", FULL_DATE_OPTIONS),
      );
    });
  });

  test("falls back to the app language when the host speaks another", () => {
    underHostLanguage("de-DE", () => {
      const date = new Date(2001, 0, 15, 13, 42);

      expect(formatCompactLocalDate(date.toISOString())).toBe(
        `${formatFriendlyDate(date, { locale: "en" })}, ${localTime(date, "en")}`,
      );
    });
  });

  test("falls back to the app language when the host reports none", () => {
    underHostLanguage("", () => {
      expect(formatLocale()).toBe("en");
    });
  });

  test("falls back to the app language where there is no navigator", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      configurable: true,
    });
    try {
      expect(formatLocale()).toBe("en");
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "navigator", original);
      } else {
        delete (globalThis as { navigator?: Navigator }).navigator;
      }
    }
  });
});
