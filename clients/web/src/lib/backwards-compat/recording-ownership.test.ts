import { beforeEach, expect, test } from "bun:test";

import {
  MIN_VERSION,
  supportsRecordingOwnership,
} from "@/lib/backwards-compat/recording-ownership";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const ASSISTANT_ID = "assistant-1";

const check = (
  version: string | null,
  ownerAssistantId: string | null = ASSISTANT_ID,
): boolean | null => {
  useAssistantIdentityStore
    .getState()
    .setIdentity("Test Assistant", version, ownerAssistantId);
  return supportsRecordingOwnership(ASSISTANT_ID);
};

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

test("enables ownership from the final claim contract's first dev build", () => {
  expect(check("0.11.6-dev.202608260331.fffffff")).toBeFalse();
  expect(check(MIN_VERSION)).toBeTrue();
  expect(check("0.11.6-dev.202608260333.abcdef0")).toBeTrue();
});

test("uses the legacy path across the stable release boundary", () => {
  expect(check("0.11.6")).toBeFalse();
  expect(check("0.11.7")).toBeTrue();
  expect(check("0.12.0")).toBeTrue();
});

test("keeps unresolved and mismatched identities undecided", () => {
  expect(check(null)).toBeNull();
  expect(check(MIN_VERSION, "assistant-other")).toBeNull();
});
