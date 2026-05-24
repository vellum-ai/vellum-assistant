import { afterEach, describe, expect, test } from "bun:test";

import {
  __resetSelfHostedRegistryForTests,
  getSelfHostedRouting,
  registerSelfHostedAssistant,
  unregisterSelfHostedAssistant,
} from "@/lib/self-hosted/registry.js";

const ASSISTANT_ID = "01h1234567890abcdefg";
const INGRESS_URL = "https://example.ngrok-free.app";

describe("self-hosted registry", () => {
  afterEach(() => {
    __resetSelfHostedRegistryForTests();
  });

  test("registers and retrieves routing entries", () => {
    registerSelfHostedAssistant(ASSISTANT_ID, INGRESS_URL);
    expect(getSelfHostedRouting(ASSISTANT_ID)).toEqual({
      assistantId: ASSISTANT_ID,
      ingressUrl: INGRESS_URL,
    });
  });

  test("returns undefined for unknown assistant ids", () => {
    expect(getSelfHostedRouting("nonexistent")).toBeUndefined();
  });

  test("overwrites an existing entry on re-registration", () => {
    registerSelfHostedAssistant(ASSISTANT_ID, INGRESS_URL);
    registerSelfHostedAssistant(ASSISTANT_ID, "https://other.example");
    expect(getSelfHostedRouting(ASSISTANT_ID)?.ingressUrl).toBe(
      "https://other.example",
    );
  });

  test("unregister removes the entry", () => {
    registerSelfHostedAssistant(ASSISTANT_ID, INGRESS_URL);
    unregisterSelfHostedAssistant(ASSISTANT_ID);
    expect(getSelfHostedRouting(ASSISTANT_ID)).toBeUndefined();
  });

  test("unregister of an unknown id is a no-op", () => {
    // Pinning the silent-no-op contract: the lifecycle hook calls
    // `unregisterSelfHostedAssistant` defensively in the active branch
    // regardless of whether the assistant was ever self-hosted. Throwing
    // here would break the active-branch transition.
    expect(() => unregisterSelfHostedAssistant("nonexistent")).not.toThrow();
  });
});
