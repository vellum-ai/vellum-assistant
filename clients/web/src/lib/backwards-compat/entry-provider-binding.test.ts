import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { assistantSupportsEntryProviderBinding } from "@/lib/backwards-compat/entry-provider-binding";
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
// `utils.test.ts`. Here we verify the boundary on each side of the dev
// floor (the assistant commit that landed entry-name writes) plus the
// conservative-on-unknown policy after the bounded version wait.
describe("assistantSupportsEntryProviderBinding", () => {
  test("returns false when the version stays unknown past the wait", async () => {
    setVersion(null);
    expect(await assistantSupportsEntryProviderBinding(null, 1)).toBe(false);
  });

  test("waits for hydration before deciding", async () => {
    setVersion(null);
    const decision = assistantSupportsEntryProviderBinding(null, 1_000);
    setVersion("0.11.4");
    expect(await decision).toBe(true);
  });

  test("returns false for the 0.11.3 stable release and older", async () => {
    setVersion("0.11.3");
    expect(await assistantSupportsEntryProviderBinding()).toBe(false);
    setVersion("0.10.12");
    expect(await assistantSupportsEntryProviderBinding()).toBe(false);
  });

  test("returns false for dev builds cut before the feature commit", async () => {
    setVersion("0.11.3-dev.202608102357.aaaaaaa");
    expect(await assistantSupportsEntryProviderBinding()).toBe(false);
  });

  test("returns true from the feature commit's dev build onward", async () => {
    setVersion("0.11.3-dev.202608102358.ef1568c");
    expect(await assistantSupportsEntryProviderBinding()).toBe(true);
    setVersion("0.11.3-dev.202608110001.bbbbbbb");
    expect(await assistantSupportsEntryProviderBinding()).toBe(true);
  });

  test("returns true for every later release, whatever it is numbered", async () => {
    setVersion("0.11.4");
    expect(await assistantSupportsEntryProviderBinding()).toBe(true);
    setVersion("0.12.0");
    expect(await assistantSupportsEntryProviderBinding()).toBe(true);
  });

  test("a hydrated identity for a different assistant gates to legacy", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("other-asst", "0.11.4", "asst-B");
    expect(await assistantSupportsEntryProviderBinding("asst-A")).toBe(false);
    expect(await assistantSupportsEntryProviderBinding("asst-B")).toBe(true);
    expect(await assistantSupportsEntryProviderBinding(null)).toBe(true);
  });

  test("an un-owned hydrated identity gates to legacy when an owner is required", async () => {
    useAssistantIdentityStore.getState().setIdentity("some-asst", "0.11.4");
    expect(await assistantSupportsEntryProviderBinding("asst-A")).toBe(false);
  });
});
