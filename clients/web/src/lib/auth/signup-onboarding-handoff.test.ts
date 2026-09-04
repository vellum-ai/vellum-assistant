import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  peekSignupOnboardingFirstName,
  resolveOnboardingFirstName,
  setSignupOnboardingFirstName,
  takeSignupOnboardingFirstName,
} from "@/lib/auth/signup-onboarding-handoff";

describe("signup onboarding first-name handoff", () => {
  let store: Map<string, string>;
  let prior: PropertyDescriptor | undefined;

  beforeEach(() => {
    store = new Map();
    prior = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });

  afterEach(() => {
    if (prior) {
      Object.defineProperty(globalThis, "sessionStorage", prior);
    } else {
      delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  });

  test("round-trips a trimmed first name", () => {
    setSignupOnboardingFirstName("  Alice  ");
    expect(peekSignupOnboardingFirstName()).toBe("Alice");
    expect(takeSignupOnboardingFirstName()).toBe("Alice");
    expect(peekSignupOnboardingFirstName()).toBeNull();
  });

  test("a blank first name does not stash a value", () => {
    setSignupOnboardingFirstName("   ");
    expect(peekSignupOnboardingFirstName()).toBeNull();
  });

  test("resolve prefers the signup stash over the session name", () => {
    setSignupOnboardingFirstName("Alice");
    expect(resolveOnboardingFirstName("Bob")).toBe("Alice");
  });

  test("resolve falls back to the session name when nothing is stashed", () => {
    expect(resolveOnboardingFirstName("Alice")).toBe("Alice");
    expect(resolveOnboardingFirstName("  ")).toBe("");
    expect(resolveOnboardingFirstName(undefined)).toBe("");
  });
});
