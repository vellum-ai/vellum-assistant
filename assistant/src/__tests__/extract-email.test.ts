import { describe, expect, it } from "bun:test";

import { extractEmail } from "../sequence/reply-matcher.js";

describe("extractEmail", () => {
  it("extracts from plain email", () => {
    expect(extractEmail("user@example.com")).toBe("user@example.com");
  });

  it("extracts from angle-bracketed email", () => {
    expect(extractEmail("<user@example.com>")).toBe("user@example.com");
  });

  it('extracts from "Name <email>" format', () => {
    expect(extractEmail('"John Doe" <john@example.com>')).toBe(
      "john@example.com",
    );
  });

  it("picks actual mailbox over display-name fragment with @", () => {
    expect(extractEmail('"Acme <support@acme.com>" <owner@example.com>')).toBe(
      "owner@example.com",
    );
  });

  it("strips parenthetical comments before segment extraction", () => {
    // The parenthetical comment contains an angle-bracketed address;
    // without stripping comments first, the code would pick ops@example.com.
    expect(
      extractEmail('"Owner" <owner@example.com> (team <ops@example.com>)'),
    ).toBe("owner@example.com");
  });

  it("handles parenthetical comment with no angle brackets", () => {
    expect(extractEmail("owner@example.com (Owner Name)")).toBe(
      "owner@example.com",
    );
  });

  it("lowercases the result", () => {
    expect(extractEmail("USER@EXAMPLE.COM")).toBe("user@example.com");
  });

  it("returns undefined for empty string", () => {
    expect(extractEmail("")).toBeUndefined();
  });

  it("returns undefined for string with no email", () => {
    expect(extractEmail("not an email")).toBeUndefined();
  });
});
