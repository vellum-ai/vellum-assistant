/**
 * A connection whose credential was force-deleted must fail its next send with
 * an actionable configuration error. Upstreams that answer an unusable key with
 * `200` and empty content otherwise reach the user as a blank assistant turn.
 */

import { describe, expect, test } from "bun:test";

import { classifyConversationError } from "../../../daemon/conversation-error.js";
import { credentialKey } from "../../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  setSecureKeyAsync,
} from "../../../security/secure-keys.js";
import { ConnectionResolutionError } from "../../routing-identity.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
} from "../../types.js";
import { MissingCredentialGuardProvider } from "../missing-credential-guard.js";

const CONNECTION_NAME = "agentrouter-primary";
const ACCOUNT = credentialKey("agentrouter", "api_key");

function respondingProvider(content: ContentBlock[]): Provider {
  return {
    name: "openai-compatible",
    sendMessage: (_messages: Message[]): Promise<ProviderResponse> =>
      Promise.resolve({
        content,
        model: "gpt-4o-mini",
        usage: { inputTokens: 12, outputTokens: 0 },
        stopReason: "end_turn",
      }),
  };
}

function guard(inner: Provider): Provider {
  return new MissingCredentialGuardProvider(inner, {
    name: CONNECTION_NAME,
    credentialAccount: ACCOUNT,
  });
}

describe("missing credential guard", () => {
  test("turns an empty upstream turn into an actionable error once the credential is gone", async () => {
    // GIVEN a connection whose credential has been force-deleted
    await deleteSecureKeyAsync(ACCOUNT);

    // AND an upstream that answers the unusable key with 200 and no content
    const provider = guard(respondingProvider([]));

    // WHEN the assistant sends through that connection
    const sending = provider.sendMessage([
      {
        role: "user",
        content: [{ type: "text", text: "посмотри последние ошибки" }],
      },
    ]);

    // THEN the send fails as a missing-credential error naming the connection
    const error = await sending.then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ConnectionResolutionError);
    const resolution = error as ConnectionResolutionError;
    expect(resolution.reason).toBe("missing_credential");
    expect(resolution.connectionName).toBe(CONNECTION_NAME);

    // AND the conversation layer renders it as a client-visible error telling
    // the user where to restore the credential, instead of an empty message
    const classified = classifyConversationError(error, {
      phase: "agent_loop",
    });
    expect(classified.userMessage).toContain(CONNECTION_NAME);
    expect(classified.userMessage).toMatch(/credential|API key/i);
    expect(classified.userMessage).toContain("Settings");
  });

  test("passes an empty turn through while the credential is still stored", async () => {
    // GIVEN a connection whose credential is present
    await setSecureKeyAsync(ACCOUNT, "sk-test-value");

    // AND an upstream that legitimately returns no content
    const provider = guard(respondingProvider([]));

    // WHEN the assistant sends through that connection
    const response = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);

    // THEN the empty response is left alone: it is not a credential problem
    expect(response.content).toEqual([]);
    await deleteSecureKeyAsync(ACCOUNT);
  });

  test("passes a normal answer through when the credential is gone", async () => {
    // GIVEN a connection with no stored credential
    await deleteSecureKeyAsync(ACCOUNT);

    // AND an upstream that still answered with text (e.g. a keyless local model)
    const provider = guard(
      respondingProvider([{ type: "text", text: "все хорошо" }]),
    );

    // WHEN the assistant sends through that connection
    const response = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);

    // THEN the answer reaches the user untouched
    expect(response.content).toEqual([{ type: "text", text: "все хорошо" }]);
  });
});
