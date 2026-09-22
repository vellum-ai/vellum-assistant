import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsDocumentCreate } from "@/lib/backwards-compat/use-supports-document-create";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER_ASSISTANT_ID = "asst-owner";

function readGate(
  version: string | null,
  identityAssistantId: string | null = OWNER_ASSISTANT_ID,
): boolean {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
  return renderHook(() => useSupportsDocumentCreate(OWNER_ASSISTANT_ID)).result
    .current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// The exhaustive semver and owner-scoping truth table lives in
// `utils.test.ts`. These cover each side of the dev floor that first carries
// `POST /v1/documents/create`, and that another assistant's version cannot
// authorize this one.
describe("useSupportsDocumentCreate", () => {
  test("false when version is unknown", () => {
    expect(readGate(null)).toBe(false);
  });

  test("false for the stable release the route postdates", () => {
    expect(readGate("0.12.2")).toBe(false);
  });

  test("false for dev builds stamped before the route landed", () => {
    expect(readGate("0.12.2-dev.202609211449.961712f")).toBe(false);
  });

  test("true for dev builds stamped once the route landed", () => {
    expect(readGate("0.12.2-dev.202609211450.3151b18")).toBe(true);
    expect(readGate("0.12.2-dev.202609221200.abcdef0")).toBe(true);
  });

  test("true for the next release", () => {
    expect(readGate("0.12.3")).toBe(true);
  });

  test("false when the version belongs to a different assistant", () => {
    expect(readGate("0.12.3", "asst-other")).toBe(false);
  });
});
