import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";
import type { ToolContext } from "../tools/types.js";

const hostAccessByConversation = new Map<string, boolean>();

mock.module("../memory/conversation-crud.js", () => ({
  getConversationHostAccess: (conversationId: string) =>
    hostAccessByConversation.get(conversationId) ?? false,
}));

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: "/tmp/test",
    conversationId: "test-conv",
    trustClass: "guardian",
    isInteractive: true,
    ...overrides,
  } as ToolContext;
}

beforeEach(() => {
  _setOverridesForTesting({});
  hostAccessByConversation.clear();
});

afterEach(() => {
  _setOverridesForTesting({});
  hostAccessByConversation.clear();
});

describe("v2-consent-policy", () => {
  test("returns legacy when the flag is disabled", async () => {
    const { evaluateV2ConsentDisposition } =
      await import("../permissions/v2-consent-policy.js");

    expect(evaluateV2ConsentDisposition("host_bash", {}, makeContext())).toBe(
      "legacy",
    );
  });

  test("auto-allows non-host tools when the flag is enabled", async () => {
    _setOverridesForTesting({ "permission-controls-v2": true });
    const { evaluateV2ConsentDisposition } =
      await import("../permissions/v2-consent-policy.js");

    expect(evaluateV2ConsentDisposition("bash", {}, makeContext())).toBe(
      "auto_allow",
    );
  });

  test("uses conversation-scoped host access when the flag is enabled", async () => {
    _setOverridesForTesting({ "permission-controls-v2": true });
    hostAccessByConversation.set("allowed-conv", true);
    hostAccessByConversation.set("blocked-conv", false);
    const { evaluateV2ConsentDisposition } =
      await import("../permissions/v2-consent-policy.js");

    expect(
      evaluateV2ConsentDisposition(
        "host_bash",
        {},
        makeContext({ conversationId: "allowed-conv" }),
      ),
    ).toBe("auto_allow");
    expect(
      evaluateV2ConsentDisposition(
        "host_bash",
        {},
        makeContext({ conversationId: "blocked-conv" }),
      ),
    ).toBe("prompt_host_access");
  });

  test("host-access prompts are identified by the stripped-down prompt shape", async () => {
    _setOverridesForTesting({ "permission-controls-v2": true });
    const {
      CONVERSATION_HOST_ACCESS_PROMPT,
      isConversationHostAccessEnablePrompt,
    } = await import("../permissions/v2-consent-policy.js");

    expect(
      isConversationHostAccessEnablePrompt({
        toolName: "host_bash",
        ...CONVERSATION_HOST_ACCESS_PROMPT,
      }),
    ).toBe(true);
    expect(
      isConversationHostAccessEnablePrompt({
        toolName: "host_bash",
        ...CONVERSATION_HOST_ACCESS_PROMPT,
        allowlistOptions: [
          {
            label: "Specific command",
            description: "legacy rule",
            pattern: "bash:*",
          },
        ],
      }),
    ).toBe(false);
  });
});
