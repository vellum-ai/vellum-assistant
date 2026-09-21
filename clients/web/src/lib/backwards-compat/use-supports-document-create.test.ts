import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { renderHook } from "@testing-library/react";

import { useSupportsDocumentCreate } from "@/lib/backwards-compat/use-supports-document-create";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

function supports(): boolean {
  return renderHook(() => useSupportsDocumentCreate()).result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

// The exhaustive semver truth table lives in `utils.test.ts`. These cover
// each side of the dev floor that first carries `POST /v1/documents/create`.
describe("useSupportsDocumentCreate", () => {
  test("false when version is unknown", () => {
    setVersion(null);
    expect(supports()).toBe(false);
  });

  test("false for the stable release the route postdates", () => {
    setVersion("0.12.2");
    expect(supports()).toBe(false);
  });

  test("false for dev builds stamped before the route landed", () => {
    setVersion("0.12.2-dev.202609211449.961712f");
    expect(supports()).toBe(false);
  });

  test("true for dev builds stamped once the route landed", () => {
    setVersion("0.12.2-dev.202609211450.3151b18");
    expect(supports()).toBe(true);
    setVersion("0.12.2-dev.202609221200.abcdef0");
    expect(supports()).toBe(true);
  });

  test("true for the next release", () => {
    setVersion("0.12.3");
    expect(supports()).toBe(true);
  });
});
