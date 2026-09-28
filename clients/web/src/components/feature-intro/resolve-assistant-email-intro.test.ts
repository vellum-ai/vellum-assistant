import { describe, expect, test } from "bun:test";

import { FEATURE_INTRO_LAUNCHED_AT } from "@/hooks/use-feature-intro-seen";

import {
  resolveAssistantEmailIntro,
  type AssistantEmailIntroInputs,
} from "./resolve-assistant-email-intro";

const LAUNCH = Date.parse(FEATURE_INTRO_LAUNCHED_AT["assistant-email"]);
const DAY_MS = 24 * 60 * 60 * 1000;
/** An assistant from the week before the intro shipped: an existing user. */
const EXISTING = new Date(LAUNCH - 7 * DAY_MS).toISOString();
/** One made the day after: a new user, who never sees it. */
const NEW = new Date(LAUNCH + DAY_MS).toISOString();

const READY: AssistantEmailIntroInputs = {
  seen: false,
  onboardingBusy: false,
  assistantCreatedAt: EXISTING,
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
  });

  test("off the platform, or once seen, nothing shows", () => {
    expect(
      resolveAssistantEmailIntro({ ...READY, status: "unavailable" }),
    ).toBeNull();
    expect(resolveAssistantEmailIntro({ ...READY, seen: true })).toBeNull();
  });

  test("the onboarding takeover is not interrupted", () => {
    expect(
      resolveAssistantEmailIntro({ ...READY, onboardingBusy: true }),
    ).toBeNull();
  });

  test("a user who joined after the launch is not introduced to it", () => {
    expect(
      resolveAssistantEmailIntro({ ...READY, assistantCreatedAt: NEW }),
    ).toBeNull();
    expect(
      resolveAssistantEmailIntro({
        ...READY,
        assistantCreatedAt: NEW,
        status: "setup",
      }),
    ).toBeNull();
  });

  test("nothing shows until the assistant's age is known", () => {
    expect(
      resolveAssistantEmailIntro({ ...READY, assistantCreatedAt: null }),
    ).toBeNull();
  });
});
