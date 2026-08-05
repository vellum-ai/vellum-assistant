import { describe, expect, test } from "bun:test";

import {
  type OAuthConnectSurfaceData,
  OAuthConnectSurfaceDataSchema,
} from "./surfaces.js";

describe("OAuthConnectSurfaceDataSchema requestedScopes", () => {
  test("parses a valid scopes array and preserves order", () => {
    const parsed = OAuthConnectSurfaceDataSchema.parse({
      providerKey: "google",
      requestedScopes: [
        "https://www.googleapis.com/auth/tasks",
        "https://www.googleapis.com/auth/calendar",
        "openid",
      ],
    });
    expect(parsed.requestedScopes).toEqual([
      "https://www.googleapis.com/auth/tasks",
      "https://www.googleapis.com/auth/calendar",
      "openid",
    ]);
  });

  test("absent requestedScopes parses to undefined", () => {
    const parsed = OAuthConnectSurfaceDataSchema.parse({
      providerKey: "google",
    });
    expect(parsed.requestedScopes).toBeUndefined();
  });

  test("an empty array collapses to undefined", () => {
    const parsed = OAuthConnectSurfaceDataSchema.parse({
      providerKey: "google",
      requestedScopes: [],
    });
    expect(parsed.requestedScopes).toBeUndefined();
  });

  test("non-array values collapse to undefined instead of rejecting", () => {
    for (const value of [
      "https://www.googleapis.com/auth/tasks, openid",
      42,
      true,
      { scope: "openid" },
      null,
    ]) {
      const parsed = OAuthConnectSurfaceDataSchema.parse({
        providerKey: "google",
        requestedScopes: value,
      });
      expect(parsed.requestedScopes).toBeUndefined();
    }
  });

  test("an array of blanks collapses to undefined", () => {
    const parsed = OAuthConnectSurfaceDataSchema.parse({
      providerKey: "google",
      requestedScopes: ["", "   ", "\t"],
    });
    expect(parsed.requestedScopes).toBeUndefined();
  });

  test("entries are trimmed and blank or non-string junk is dropped", () => {
    const parsed = OAuthConnectSurfaceDataSchema.parse({
      providerKey: "google",
      requestedScopes: [
        "  https://www.googleapis.com/auth/tasks  ",
        "",
        null,
        { nope: true },
        "openid",
      ],
    });
    expect(parsed.requestedScopes).toEqual([
      "https://www.googleapis.com/auth/tasks",
      "openid",
    ]);
  });

  test("a bare string is not split on commas (scopes are opaque URIs)", () => {
    const parsed = OAuthConnectSurfaceDataSchema.parse({
      providerKey: "google",
      requestedScopes: "a,b,c",
    });
    expect(parsed.requestedScopes).toBeUndefined();
  });

  test("legacy payload { providerKey: 'google' } still parses (skew guard)", () => {
    const parsed: OAuthConnectSurfaceData = OAuthConnectSurfaceDataSchema.parse(
      { providerKey: "google" },
    );
    expect(parsed.providerKey).toBe("google");
    expect(parsed.requestedScopes).toBeUndefined();
  });
});
