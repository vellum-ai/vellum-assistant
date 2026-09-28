import { describe, expect, test } from "bun:test";

import {
  resolveAssistantEmailIntro,
  type AssistantEmailIntroInputs,
} from "./resolve-assistant-email-intro";

const READY: AssistantEmailIntroInputs = {
  seen: false,
  flagsHydrated: true,
  inboxEnabled: true,
  onboardingBusy: false,
  status: "upgrade",
};

describe("resolveAssistantEmailIntro", () => {
  test("a plan without email gets the locked pitch", () => {
    expect(resolveAssistantEmailIntro(READY)).toBe("locked");
  });

  test("an entitled assistant with no address gets the way into setup", () => {
    expect(resolveAssistantEmailIntro({ ...READY, status: "setup" })).toBe(
      "open",
    );
  });

  test("an assistant with an address is not introduced to it", () => {
    expect(
      resolveAssistantEmailIntro({ ...READY, status: "ready" }),
    ).toBeNull();
  });

  test("nothing shows while the reads that decide are pending", () => {
    expect(
      resolveAssistantEmailIntro({ ...READY, status: "loading" }),
    ).toBeNull();
    expect(
      resolveAssistantEmailIntro({ ...READY, flagsHydrated: false }),
    ).toBeNull();
  });

  test("off the platform, behind the flag, or once seen, nothing shows", () => {
    expect(
      resolveAssistantEmailIntro({ ...READY, status: "unavailable" }),
    ).toBeNull();
    expect(
      resolveAssistantEmailIntro({ ...READY, inboxEnabled: false }),
    ).toBeNull();
    expect(resolveAssistantEmailIntro({ ...READY, seen: true })).toBeNull();
  });

  test("the onboarding takeover is not interrupted", () => {
    expect(
      resolveAssistantEmailIntro({ ...READY, onboardingBusy: true }),
    ).toBeNull();
  });
});
