import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { supportsServerMintedConversation } from "@/lib/backwards-compat/server-minted-conversation";
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
// `utils.test.ts`. Here we verify the boundary on each side of 0.8.6
// plus the conservative-on-unknown policy.
describe("supportsServerMintedConversation", () => {
  test("returns false when version is unknown", () => {
    setVersion(null);
    expect(supportsServerMintedConversation()).toBe(false);
  });

  test("returns false for assistants on 0.8.5 and older", () => {
    setVersion("0.8.5");
    expect(supportsServerMintedConversation()).toBe(false);
    setVersion("0.8.4");
    expect(supportsServerMintedConversation()).toBe(false);
    setVersion("0.7.0");
    expect(supportsServerMintedConversation()).toBe(false);
  });

  test("returns true for assistants on 0.8.6+", () => {
    setVersion("0.8.6");
    expect(supportsServerMintedConversation()).toBe(true);
    setVersion("0.9.0");
    expect(supportsServerMintedConversation()).toBe(true);
    setVersion("1.0.0");
    expect(supportsServerMintedConversation()).toBe(true);
  });

  test("treats RC builds of the cutover patch as supporting the new flow", () => {
    // 0.8.6-rc.1 ships with the same handlers as 0.8.6, so RC
    // testers must get the new flow.
    setVersion("0.8.6-rc.1");
    expect(supportsServerMintedConversation()).toBe(true);
    setVersion("0.8.6-beta");
    expect(supportsServerMintedConversation()).toBe(true);
  });

  test("returns false for unparseable versions", () => {
    setVersion("garbage");
    expect(supportsServerMintedConversation()).toBe(false);
    setVersion("0.8");
    expect(supportsServerMintedConversation()).toBe(false);
  });
});
