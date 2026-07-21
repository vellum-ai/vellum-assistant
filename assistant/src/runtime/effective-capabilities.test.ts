import { describe, expect, test } from "bun:test";

import {
  canActOnPrivilegedDocuments,
  isArchiveBySenderAuthorized,
} from "./effective-capabilities.js";

describe("canActOnPrivilegedDocuments", () => {
  test("guardian is privileged regardless of channel", () => {
    expect(canActOnPrivilegedDocuments({ trustClass: "guardian" })).toBe(true);
    expect(
      canActOnPrivilegedDocuments({
        trustClass: "guardian",
        executionChannel: "telegram",
      }),
    ).toBe(true);
  });

  test("non-guardian is privileged only on a privileged channel", () => {
    expect(
      canActOnPrivilegedDocuments({
        trustClass: "trusted_contact",
        executionChannel: "telegram",
      }),
    ).toBe(false);
    expect(
      canActOnPrivilegedDocuments({
        trustClass: "trusted_contact",
        executionChannel: "vellum",
      }),
    ).toBe(true);
  });

  test("the vellum channel grants access even to unknown actors", () => {
    expect(
      canActOnPrivilegedDocuments({
        trustClass: "unknown",
        executionChannel: "vellum",
      }),
    ).toBe(true);
    expect(canActOnPrivilegedDocuments({ trustClass: "unknown" })).toBe(false);
  });
});

describe("isArchiveBySenderAuthorized", () => {
  test("any non-self authorization path suffices", () => {
    expect(
      isArchiveBySenderAuthorized({
        trustClass: "unknown",
        triggeredBySurfaceAction: true,
      }),
    ).toBe(true);
    expect(
      isArchiveBySenderAuthorized({
        trustClass: "unknown",
        batchAuthorizedByTask: true,
      }),
    ).toBe(true);
    expect(
      isArchiveBySenderAuthorized({
        trustClass: "unknown",
        approvedViaPrompt: true,
      }),
    ).toBe(true);
  });

  test("user_approved self-authorizes only for a permitted trust class", () => {
    expect(
      isArchiveBySenderAuthorized({
        trustClass: "guardian",
        userApproved: true,
      }),
    ).toBe(true);
    expect(
      isArchiveBySenderAuthorized({
        trustClass: "trusted_contact",
        userApproved: true,
      }),
    ).toBe(false);
  });

  test("unauthorized when no path applies", () => {
    expect(isArchiveBySenderAuthorized({ trustClass: "guardian" })).toBe(false);
    expect(
      isArchiveBySenderAuthorized({
        trustClass: "trusted_contact",
        triggeredBySurfaceAction: false,
        userApproved: false,
      }),
    ).toBe(false);
  });
});
