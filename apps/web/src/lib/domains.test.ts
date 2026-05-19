import { describe, expect, test } from "bun:test";

import {
  isVellumDomain,
  PLATFORM_HOSTED_HOSTNAMES,
} from "@/lib/domains.js";

describe("isVellumDomain", () => {
  test("returns true for apex domain", () => {
    expect(isVellumDomain("vellum.ai")).toBe(true);
  });

  test("returns true for www.vellum.ai", () => {
    expect(isVellumDomain("www.vellum.ai")).toBe(true);
  });

  test("returns true for any subdomain of vellum.ai", () => {
    expect(isVellumDomain("app.vellum.ai")).toBe(true);
  });

  test("returns false for evil-vellum.ai", () => {
    expect(isVellumDomain("evil-vellum.ai")).toBe(false);
  });

  test("returns false for vellum.ai.evil.com", () => {
    expect(isVellumDomain("vellum.ai.evil.com")).toBe(false);
  });

  test("returns false for notvellum.ai", () => {
    expect(isVellumDomain("notvellum.ai")).toBe(false);
  });

  test("returns false for localhost", () => {
    expect(isVellumDomain("localhost")).toBe(false);
  });
});

describe("PLATFORM_HOSTED_HOSTNAMES", () => {
  test("contains www.vellum.ai", () => {
    expect(PLATFORM_HOSTED_HOSTNAMES).toContain("www.vellum.ai");
  });

  test("contains vellum.ai", () => {
    expect(PLATFORM_HOSTED_HOSTNAMES).toContain("vellum.ai");
  });
});
