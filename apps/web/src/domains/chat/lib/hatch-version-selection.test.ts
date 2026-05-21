import { describe, expect, test } from "bun:test";

import {
  isVellumStaffUser,
  shouldShowHatchVersionSelector,
} from "./hatch-version-selection.js";

const VELLUM_EMAIL_DOMAIN = "vellum.ai";

describe("shouldShowHatchVersionSelector", () => {
  test("allows Vellum staff in dev or staging", () => {
    expect(
      shouldShowHatchVersionSelector({
        isDevOrStaging: true,
        isVellumStaff: true,
      }),
    ).toBe(true);
  });

  test("blocks non-staff users in dev or staging", () => {
    expect(
      shouldShowHatchVersionSelector({
        isDevOrStaging: true,
        isVellumStaff: false,
      }),
    ).toBe(false);
  });

  test("blocks staff users in production", () => {
    expect(
      shouldShowHatchVersionSelector({
        isDevOrStaging: false,
        isVellumStaff: true,
      }),
    ).toBe(false);
  });
});

describe("isVellumStaffUser", () => {
  test("allows users marked as staff", () => {
    expect(isVellumStaffUser(null, true)).toBe(true);
  });

  test("allows users with a Vellum email domain", () => {
    expect(isVellumStaffUser(`user@${VELLUM_EMAIL_DOMAIN}`, false)).toBe(true);
  });

  test("blocks users without a Vellum email domain or staff flag", () => {
    expect(isVellumStaffUser("user@example.com", false)).toBe(false);
  });
});
