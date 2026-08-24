import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveSupportsBatchedQuestionSubmit } from "@/lib/backwards-compat/batched-question-submit";
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

// The exhaustive truth-table for the semver comparison lives in `utils.test.ts`.
// What matters here is the boundary at 0.8.2, the conservative answers that
// send the legacy shape, and the owner scoping.
describe("resolveSupportsBatchedQuestionSubmit", () => {
  test("resolves true on the first version carrying the batched route", async () => {
    seed("0.8.2");
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

  test("resolves false when the version belongs to another assistant", async () => {
    seed("0.11.4", "asst-other");
    expect(await resolveSupportsBatchedQuestionSubmit(OWNER_ASSISTANT_ID)).toBe(
      false,
    );
  });

  test("resolves false for a null owner", async () => {
    seed("0.11.4");
    expect(await resolveSupportsBatchedQuestionSubmit(null)).toBe(false);
  });

  test("waits for the version rather than reading the unhydrated false", async () => {
    const pending = resolveSupportsBatchedQuestionSubmit(OWNER_ASSISTANT_ID);
    seed("0.11.4");
    expect(await pending).toBe(true);
  });
});
