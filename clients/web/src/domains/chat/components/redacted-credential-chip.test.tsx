/**
 * Tests for RedactedCredentialChip's reveal scoping.
 *
 * The security-critical property (LUM-2768): the reveal request must be scoped
 * to the transcript's own assistant when one is passed, NOT the globally active
 * assistant. A transcript rendered for assistant B must never reveal against
 * assistant A just because A happens to be active — colliding `service:field`
 * names would otherwise leak B's credential from A's vault.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";

// The enriched not-revealed chip exposes two controls that trigger reveal (the
// blurred value button and the eye-icon button); either fires the same request.
const REVEAL_LABEL = "Reveal value for anthropic:api_key";

const credentialsRevealPost = mock(async (_args: unknown) => ({
  data: { value: "revealed-secret" },
}));
mock.module("@/generated/daemon/sdk.gen", () => ({
  credentialsRevealPost,
}));

import { RedactedCredentialChip } from "@/domains/chat/components/redacted-credential-chip";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const ENRICHED = {
  type: "Anthropic API Key",
  service: "anthropic",
  field: "api_key",
};

function lastRevealAssistantId(): unknown {
  const call = credentialsRevealPost.mock.calls.at(-1);
  const args = call?.[0] as { path?: { assistant_id?: unknown } } | undefined;
  return args?.path?.assistant_id;
}

afterEach(() => {
  credentialsRevealPost.mockClear();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

describe("RedactedCredentialChip reveal scoping", () => {
  test("reveals against the transcript assistantId, not the active assistant", async () => {
    // Active assistant is a DIFFERENT assistant than the transcript owner.
    useResolvedAssistantsStore.setState({
      activeAssistantId: "active-assistant",
    });

    const { getAllByLabelText } = render(
      <RedactedCredentialChip
        {...ENRICHED}
        assistantId="transcript-assistant"
      />,
    );

    fireEvent.click(getAllByLabelText(REVEAL_LABEL)[0]);

    await waitFor(() => expect(credentialsRevealPost).toHaveBeenCalledTimes(1));
    expect(lastRevealAssistantId()).toBe("transcript-assistant");
  });

  test("falls back to the active assistant when no assistantId prop is passed", async () => {
    useResolvedAssistantsStore.setState({
      activeAssistantId: "active-assistant",
    });

    const { getAllByLabelText } = render(
      <RedactedCredentialChip {...ENRICHED} />,
    );

    fireEvent.click(getAllByLabelText(REVEAL_LABEL)[0]);

    await waitFor(() => expect(credentialsRevealPost).toHaveBeenCalledTimes(1));
    expect(lastRevealAssistantId()).toBe("active-assistant");
  });

  test("is not revealable when the transcript assistantId is explicitly null", () => {
    // An explicit null owner (pre-active transcript) must not fall through to
    // the active assistant — the chip stays a non-revealable badge.
    useResolvedAssistantsStore.setState({
      activeAssistantId: "active-assistant",
    });

    const { queryAllByLabelText } = render(
      <RedactedCredentialChip {...ENRICHED} assistantId={null} />,
    );

    expect(queryAllByLabelText(REVEAL_LABEL)).toHaveLength(0);
  });
});
