import { describe, expect, test } from "bun:test";

import {
  DEFAULT_GOOGLE_SERVICES,
  deriveGoogleServices,
  GOOGLE_SERVICE_CALENDAR,
  GOOGLE_SERVICE_GMAIL,
  isGoogleServiceGranted,
} from "./google-service-labels.js";

const CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const DRIVE = "https://www.googleapis.com/auth/drive";

describe("deriveGoogleServices", () => {
  test("assumes the default bundle when scopes are missing", () => {
    expect(deriveGoogleServices()).toEqual(DEFAULT_GOOGLE_SERVICES);
    expect(deriveGoogleServices([])).toEqual(DEFAULT_GOOGLE_SERVICES);
  });

  test("maps known scopes to their service labels", () => {
    expect(deriveGoogleServices([CALENDAR_EVENTS])).toEqual([
      GOOGLE_SERVICE_CALENDAR,
    ]);
    expect(
      deriveGoogleServices([GMAIL_MODIFY, CALENDAR_EVENTS, DRIVE]),
    ).toEqual(["Gmail", "Calendar", "Drive"]);
  });

  test("collapses duplicate scopes for the same service", () => {
    expect(
      deriveGoogleServices([
        GMAIL_MODIFY,
        "https://www.googleapis.com/auth/gmail.send",
      ]),
    ).toEqual([GOOGLE_SERVICE_GMAIL]);
  });

  test("falls back to the default bundle when nothing maps", () => {
    expect(
      deriveGoogleServices(["https://www.googleapis.com/auth/unknown.scope"]),
    ).toEqual(DEFAULT_GOOGLE_SERVICES);
  });
});

describe("isGoogleServiceGranted", () => {
  test("treats unknown scopes as granted (unknown → assume granted)", () => {
    expect(isGoogleServiceGranted(GOOGLE_SERVICE_CALENDAR)).toBe(true);
    expect(isGoogleServiceGranted(GOOGLE_SERVICE_CALENDAR, [])).toBe(true);
  });

  test("gates on a positive denial when scopes are known", () => {
    expect(
      isGoogleServiceGranted(GOOGLE_SERVICE_CALENDAR, [GMAIL_MODIFY]),
    ).toBe(false);
    expect(
      isGoogleServiceGranted(GOOGLE_SERVICE_CALENDAR, [CALENDAR_EVENTS]),
    ).toBe(true);
  });
});
