import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsMetadataAttachmentHistory } from "@/lib/backwards-compat/use-supports-metadata-attachment-history";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER_ID = "asst-owner";

function check(
  version: string | null,
  identityAssistantId: string | null = OWNER_ID,
): boolean {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
  const { result, unmount } = renderHook(() =>
    useSupportsMetadataAttachmentHistory(OWNER_ID),
  );
  const supported = result.current;
  unmount();
  return supported;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useSupportsMetadataAttachmentHistory", () => {
  test("keeps legacy inline history while the version is unknown or old", () => {
    expect(check(null)).toBe(false);
    expect(check("0.10.11")).toBe(false);
  });

  test("enables metadata history at 0.10.12 and above", () => {
    expect(check("0.10.12")).toBe(true);
    expect(check("0.10.12-dev.202607240100.abc1234")).toBe(true);
    expect(check("0.11.0")).toBe(true);
  });

  test("stays conservative when the identity belongs to another assistant", () => {
    expect(check("0.10.12", "asst-previous")).toBe(false);
  });
});
