import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { supportsAvatarStateManifest } from "@/lib/backwards-compat/avatar-state-manifest";
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
// `utils.test.ts`. Here we verify the boundary on each side of 0.8.7
// plus the conservative-on-unknown policy.
describe("supportsAvatarStateManifest", () => {
  test("returns false when version is unknown", () => {
    setVersion(null);
    expect(supportsAvatarStateManifest()).toBe(false);
  });

  test("returns false for assistants on 0.8.6 and older", () => {
    setVersion("0.8.6");
    expect(supportsAvatarStateManifest()).toBe(false);
    setVersion("0.8.5");
    expect(supportsAvatarStateManifest()).toBe(false);
    setVersion("0.7.0");
    expect(supportsAvatarStateManifest()).toBe(false);
  });

  test("returns true for assistants on 0.8.7+", () => {
    setVersion("0.8.7");
    expect(supportsAvatarStateManifest()).toBe(true);
    setVersion("0.9.0");
    expect(supportsAvatarStateManifest()).toBe(true);
    setVersion("1.0.0");
    expect(supportsAvatarStateManifest()).toBe(true);
  });

  test("treats pre-release builds of the cutover patch as supporting the manifest", () => {
    // 0.8.7-staging.N is built from the same commit that adds the
    // manifest routes, so staging testers must get the new path.
    setVersion("0.8.7-staging.1");
    expect(supportsAvatarStateManifest()).toBe(true);
    setVersion("0.8.7-rc.1");
    expect(supportsAvatarStateManifest()).toBe(true);
  });

  test("returns false for unparseable versions", () => {
    setVersion("garbage");
    expect(supportsAvatarStateManifest()).toBe(false);
    setVersion("0.8");
    expect(supportsAvatarStateManifest()).toBe(false);
  });
});
