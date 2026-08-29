import { beforeEach, describe, expect, it } from "bun:test";

import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import {
  MIN_VERSION,
  supportsContactFormCancellation,
} from "./contact-form-cancellation";

const OWNER = "asst-1";

function setVersion(version: string | null): void {
  useAssistantIdentityStore.setState({ version, assistantId: OWNER });
}

describe("supportsContactFormCancellation", () => {
  beforeEach(() => {
    setVersion(null);
  });

  it("is false before the version is known", () => {
    // The local-only dismissal is what every supported assistant tolerates, so
    // an unknown version takes that path rather than risking a 400 that would
    // leave the card undismissable.
    expect(supportsContactFormCancellation(OWNER)).toBe(false);
  });

  it("is false on an assistant whose submit route rejects a dismissal", () => {
    setVersion("0.11.6");
    expect(supportsContactFormCancellation(OWNER)).toBe(false);
  });

  it("is true on a dev build from the carrying commit onwards", () => {
    // Builds from this source report 0.11.7-dev.*, and they serve the field,
    // so a floor at the next release number would degrade them.
    setVersion(MIN_VERSION);
    expect(supportsContactFormCancellation(OWNER)).toBe(true);
    setVersion("0.11.7-dev.202608290900.abcdef1");
    expect(supportsContactFormCancellation(OWNER)).toBe(true);
  });

  it("is false on a dev build stamped before the commit landed", () => {
    // Dev versions are stamped in UTC. A floor taken from the committer's
    // local time would admit builds from the hours before the change.
    setVersion("0.11.7-dev.202608281600.0000000");
    expect(supportsContactFormCancellation(OWNER)).toBe(false);
  });

  it("is true from the build that first carries it", () => {
    setVersion(MIN_VERSION);
    expect(supportsContactFormCancellation(OWNER)).toBe(true);
  });

  it("is false on the 0.11.7 release, which was cut before this landed", () => {
    // A dev build of X.Y.Z is treated as ahead of the X.Y.Z release here,
    // because it carries commits the release does not. That is what makes the
    // dev anchor correct: it admits the builds that have the field and still
    // excludes the release that predates it.
    setVersion("0.11.7");
    expect(supportsContactFormCancellation(OWNER)).toBe(false);
  });

  it("is true on the next release", () => {
    setVersion("0.11.8");
    expect(supportsContactFormCancellation(OWNER)).toBe(true);
  });

  it("is false for a form belonging to a different assistant", () => {
    // The version held is the active assistant's. A form raised by another one
    // is not covered by it, and answering from it could post the field to an
    // assistant that rejects it.
    setVersion("0.11.8");
    expect(supportsContactFormCancellation("asst-other")).toBe(false);
  });

  it("is true on anything newer", () => {
    setVersion("0.13.4");
    expect(supportsContactFormCancellation(OWNER)).toBe(true);
  });
});
