/**
 * Tests for the research flow's adopt-vs-managed-hatch decision. The explicit
 * hosting choice must win when present; a missing query string must fall back
 * to the live-session signal so a pre-hatched local assistant is never routed
 * onto the managed hatch (which gates the flow on a wake that never ends
 * against a local gateway).
 */

import { describe, expect, test } from "bun:test";

import { shouldAdoptExistingAssistant } from "./adopt-existing-assistant";

describe("shouldAdoptExistingAssistant", () => {
  test("platform (non-local) builds always run the managed hatch", () => {
    for (const hostingParam of [null, "local", "docker", "vellum-cloud"]) {
      expect(
        shouldAdoptExistingAssistant({
          hostingParam,
          localMode: false,
          gatewayAuthSession: false,
        }),
      ).toBe(false);
    }
  });

  test("explicit local/docker hosting adopts the foreground-hatched assistant", () => {
    for (const hostingParam of ["local", "docker"]) {
      expect(
        shouldAdoptExistingAssistant({
          hostingParam,
          localMode: true,
          gatewayAuthSession: false,
        }),
      ).toBe(true);
    }
  });

  test("explicit vellum-cloud hosting runs the managed hatch even over a live local session", () => {
    // The desktop app can onboard a managed assistant while still holding a
    // gateway session from a previous local one — the explicit choice wins.
    expect(
      shouldAdoptExistingAssistant({
        hostingParam: "vellum-cloud",
        localMode: true,
        gatewayAuthSession: true,
      }),
    ).toBe(false);
  });

  test("no hosting param with a live local session adopts the connected assistant", () => {
    // A refresh or back-navigation that lost the query string must not strand
    // a pre-hatched local assistant behind the managed wake gate.
    expect(
      shouldAdoptExistingAssistant({
        hostingParam: null,
        localMode: true,
        gatewayAuthSession: true,
      }),
    ).toBe(true);
  });

  test("no hosting param and no local session runs the managed hatch", () => {
    // Desktop app connected to a Vellum-Cloud assistant (platform session):
    // the managed hatch resolves that existing assistant.
    expect(
      shouldAdoptExistingAssistant({
        hostingParam: null,
        localMode: true,
        gatewayAuthSession: false,
      }),
    ).toBe(false);
  });
});
