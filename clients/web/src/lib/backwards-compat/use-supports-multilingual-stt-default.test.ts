/**
 * The write-side resolver for the multilingual STT default.
 *
 * The read hook is a thin `useAssistantScopedSupports` wrapper covered by the
 * shared gate tests; what needs its own coverage is the resolver, because a
 * wrong answer there is persisted rather than re-rendered. `config_patch`
 * cannot delete `services.stt.language`, so a legacy-shaped write pins
 * English on an assistant whose real default is code-switching.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveSupportsMultilingualSttDefault } from "@/lib/backwards-compat/use-supports-multilingual-stt-default";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER = "asst-owner";
const OTHER = "asst-other";

/** `setIdentity` is (name, version, assistantId): the id is the third arg. */
function setIdentityFor(assistantId: string, version: string): void {
  useAssistantIdentityStore
    .getState()
    .setIdentity("Test Assistant", version, assistantId);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("resolveSupportsMultilingualSttDefault", () => {
  test("resolves true once the owner's own version arrives", async () => {
    const pending = resolveSupportsMultilingualSttDefault(OWNER);
    setIdentityFor(OWNER, "0.12.0");
    expect(await pending).toBe(true);
  });

  test("waits past a version held for a different assistant", async () => {
    // The scenario the scoped wait exists for: the store still holds the
    // previously-viewed assistant's version, so an unscoped wait would
    // resolve immediately and the owner mismatch would answer false, sending
    // the write down the legacy path for a 0.12.0 assistant.
    setIdentityFor(OTHER, "0.12.0");

    const pending = resolveSupportsMultilingualSttDefault(OWNER);
    setIdentityFor(OWNER, "0.12.0");

    expect(await pending).toBe(true);
  });

  test("resolves false for an owner that is genuinely older", async () => {
    setIdentityFor(OWNER, "0.11.1");
    expect(await resolveSupportsMultilingualSttDefault(OWNER)).toBe(false);
  });

  test("resolves false without hanging when there is no owner", async () => {
    // The scoped gate reports false for a null owner regardless, so there is
    // nothing to wait for and the write must not stall on the timeout.
    expect(await resolveSupportsMultilingualSttDefault(null)).toBe(false);
  });
});
