import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  MIN_VERSION,
  resolveSupportsBatchedQuestionSubmit,
} from "@/lib/backwards-compat/batched-question-submit";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER_ASSISTANT_ID = "asst-owner";

function seed(
  version: string | null,
  identityAssistantId: string | null = OWNER_ASSISTANT_ID,
): void {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

// The exhaustive truth-table for the semver comparison and for the owner rule
// lives in `utils.test.ts`. What matters here is the boundary this gate names,
// the conservative answers that send the legacy shape, and that the read is the
// scoped one. No case leaves a scoped wait unsatisfied: a wait for an owner the
// store never carries blocks for its full timeout, outliving the test that
// started it and then reading whatever a later test left in the store.
describe("resolveSupportsBatchedQuestionSubmit", () => {
  test("resolves true on the first version carrying the batched route", async () => {
    seed(MIN_VERSION);
    expect(await resolveSupportsBatchedQuestionSubmit(OWNER_ASSISTANT_ID)).toBe(
      true,
    );
  });

  test("resolves true for later versions", async () => {
    seed("0.11.4");
    expect(await resolveSupportsBatchedQuestionSubmit(OWNER_ASSISTANT_ID)).toBe(
      true,
    );
  });

  test("resolves false for assistants below the floor", async () => {
    seed("0.8.1");
    expect(await resolveSupportsBatchedQuestionSubmit(OWNER_ASSISTANT_ID)).toBe(
      false,
    );
  });

  test("resolves false for an unparseable version", async () => {
    seed("garbage");
    expect(await resolveSupportsBatchedQuestionSubmit(OWNER_ASSISTANT_ID)).toBe(
      false,
    );
  });

  // An unscoped gate would answer `true` here: it reads the version alone and
  // never asks who it was fetched for. `false` is what makes this one scoped.
  test("resolves false for a null owner even with a supported version", async () => {
    seed("0.11.4");
    expect(await resolveSupportsBatchedQuestionSubmit(null)).toBe(false);
  });

  test("waits for the version rather than reading the unhydrated false", async () => {
    const pending = resolveSupportsBatchedQuestionSubmit(OWNER_ASSISTANT_ID);
    seed("0.11.4");
    expect(await pending).toBe(true);
  });
});
