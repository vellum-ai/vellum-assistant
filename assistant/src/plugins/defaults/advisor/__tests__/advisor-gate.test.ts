import { describe, expect, mock, test } from "bun:test";

// Drive the gate off a controllable llm config + a stubbed default-profile
// resolver, so we can assert the default-on semantics precisely.
let mockLlm: {
  profiles: Record<string, { advisorEnabled?: boolean | null }>;
  activeProfile?: string;
} = { profiles: {} };

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({ llm: mockLlm }),
}));
mock.module("../../../../config/llm-resolver.js", () => ({
  resolveDefaultProfileKey: () => "balanced",
}));

const { advisorEnabledForProfile } = await import("../advisor-gate.js");

describe("advisorEnabledForProfile", () => {
  test("default-on when the profile omits the flag", () => {
    mockLlm = { profiles: { p: {} }, activeProfile: "p" };
    expect(advisorEnabledForProfile("p")).toBe(true);
  });

  test("default-on when the flag is null", () => {
    mockLlm = { profiles: { p: { advisorEnabled: null } }, activeProfile: "p" };
    expect(advisorEnabledForProfile("p")).toBe(true);
  });

  test("disabled only on an explicit false", () => {
    mockLlm = {
      profiles: { p: { advisorEnabled: false } },
      activeProfile: "p",
    };
    expect(advisorEnabledForProfile("p")).toBe(false);
  });

  test("enabled on an explicit true", () => {
    mockLlm = { profiles: { p: { advisorEnabled: true } }, activeProfile: "p" };
    expect(advisorEnabledForProfile("p")).toBe(true);
  });

  test("falls back to the active profile when modelProfile is null", () => {
    mockLlm = {
      profiles: { a: { advisorEnabled: false } },
      activeProfile: "a",
    };
    expect(advisorEnabledForProfile(null)).toBe(false);
  });

  test("falls back to the call-site default profile when neither is set", () => {
    // resolveDefaultProfileKey is stubbed to "balanced".
    mockLlm = { profiles: { balanced: { advisorEnabled: false } } };
    expect(advisorEnabledForProfile(null)).toBe(false);
  });
});
