import { beforeEach, describe, expect, it } from "bun:test";

import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import {
  MIN_VERSION,
  supportsContactFormCancellation,
} from "./contact-form-cancellation";

function setVersion(version: string | null): void {
  useAssistantIdentityStore.setState({ version });
}

describe("supportsContactFormCancellation", () => {
  beforeEach(() => {
    setVersion(null);
  });

  it("is false before the version is known", () => {
    // The local-only dismissal is what every supported assistant tolerates, so
    // an unknown version takes that path rather than risking a 400 that would
    // leave the card undismissable.
    expect(supportsContactFormCancellation()).toBe(false);
  });

  it("is false on an assistant whose submit route rejects a dismissal", () => {
    setVersion("0.11.9");
    expect(supportsContactFormCancellation()).toBe(false);
  });

  it("is true from the release that understands it", () => {
    setVersion(MIN_VERSION);
    expect(supportsContactFormCancellation()).toBe(true);
  });

  it("is true on anything newer", () => {
    setVersion("0.13.4");
    expect(supportsContactFormCancellation()).toBe(true);
  });
});
