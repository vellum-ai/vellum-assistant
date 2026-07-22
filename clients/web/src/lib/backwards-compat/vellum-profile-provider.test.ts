import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { assistantSupportsVellumProviderProfiles } from "@/lib/backwards-compat/vellum-profile-provider";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive truth-table for the underlying semver gate lives in
// `utils.test.ts`. Here we verify the boundary on each side of 0.10.12
// plus the conservative-on-unknown policy after the bounded version wait.
describe("assistantSupportsVellumProviderProfiles", () => {
  test("returns false when the version stays unknown past the wait", async () => {
    setVersion(null);
    expect(await assistantSupportsVellumProviderProfiles(1)).toBe(false);
  });

  test("waits for hydration before deciding", async () => {
    setVersion(null);
    const decision = assistantSupportsVellumProviderProfiles(1_000);
    setVersion("0.10.12");
    expect(await decision).toBe(true);
  });

  test("returns false for assistants on 0.10.11 and older", async () => {
    setVersion("0.10.11");
    expect(await assistantSupportsVellumProviderProfiles()).toBe(false);
    setVersion("0.9.9");
    expect(await assistantSupportsVellumProviderProfiles()).toBe(false);
  });

  test("returns true from 0.10.12, including pre-releases", async () => {
    setVersion("0.10.12");
    expect(await assistantSupportsVellumProviderProfiles()).toBe(true);
    setVersion("0.10.12-staging.1");
    expect(await assistantSupportsVellumProviderProfiles()).toBe(true);
    setVersion("0.11.0");
    expect(await assistantSupportsVellumProviderProfiles()).toBe(true);
  });
});
