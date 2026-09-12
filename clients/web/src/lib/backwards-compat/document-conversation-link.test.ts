import { afterEach, describe, expect, test } from "bun:test";

import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import {
  MIN_VERSION,
  resolveSupportsDocumentConversationLink,
} from "./document-conversation-link";

const identity = useAssistantIdentityStore.getState();

afterEach(() => {
  useAssistantIdentityStore.setState(identity, true);
});

describe("document conversation link compatibility", () => {
  test.each([
    { version: "0.8.3", supported: false },
    { version: MIN_VERSION, supported: true },
    { version: "0.8.4-rc.1", supported: true },
    { version: "0.8.4-dev.202605210000.abc1234", supported: true },
    { version: "0.11.12", supported: true },
    { version: "unknown", supported: false },
  ])(
    "$version supports linking: $supported",
    async ({ version, supported }) => {
      useAssistantIdentityStore.setState({
        assistantId: "assistant-1",
        version,
      });
      expect(await resolveSupportsDocumentConversationLink("assistant-1")).toBe(
        supported,
      );
    },
  );

  test.each([null, "assistant-2"])(
    "waits for the target identity when the version belongs to %s",
    async (assistantId) => {
      useAssistantIdentityStore.setState({
        assistantId,
        version: assistantId ? "0.11.12" : null,
      });
      let settled = false;
      const pending = resolveSupportsDocumentConversationLink("assistant-1");
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      useAssistantIdentityStore.setState({
        assistantId: "assistant-1",
        version: MIN_VERSION,
      });
      expect(await pending).toBe(true);
    },
  );

  test("a missing owner cannot authorize a link", async () => {
    useAssistantIdentityStore.setState({
      assistantId: "assistant-1",
      version: MIN_VERSION,
    });
    expect(await resolveSupportsDocumentConversationLink(null)).toBe(false);
  });
});
