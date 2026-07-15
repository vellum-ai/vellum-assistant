import { useState } from "react";

import { Typography } from "@vellumai/design-library/components/typography";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ConnectClaudePanel } from "@/components/connect-claude-panel";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { useConnectClaude } from "@/hooks/use-connect-claude";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

// ---------------------------------------------------------------------------
// Inline "Connect Claude Code" affordance for a failed ACP spawn
// ---------------------------------------------------------------------------
//
// When an `acp_spawn` fails because the `claude-agent-acp` OAuth token is
// missing, the daemon tags the tool result with a structured `errorCode` marker
// (see `ACP_CLAUDE_OAUTH_MISSING_CODE` in
// `assistant/src/acp/prepare-agent-env.ts`). The transcript renders this inline
// affordance so the user can complete the OAuth flow in one round-trip instead
// of reading dead error text and running a CLI prompt. Gated behind the
// `acp-claude-oauth-connect` flag; when the flag is off the component renders
// nothing and the tool call keeps its plain error rendering.

/**
 * Stable marker the daemon sets on a missing-token `acp_spawn` tool result.
 * Mirror of the daemon literal `ACP_CLAUDE_OAUTH_MISSING_CODE`; the two are a
 * wire contract and must stay in sync.
 */
export const ACP_CLAUDE_OAUTH_MISSING_CODE = "acp_claude_oauth_missing";

/** True when a tool call is a missing-token ACP spawn failure. */
export function toolCallNeedsClaudeConnect(tc: ChatMessageToolCall): boolean {
  return tc.isError === true && tc.errorCode === ACP_CLAUDE_OAUTH_MISSING_CODE;
}

export function AcpConnectAffordance() {
  const enabled = useAssistantFeatureFlagStore.use.acpClaudeOauthConnect();
  if (!enabled) {
    // Flag off → fall back to the plain error rendering.
    return null;
  }
  return <AcpConnectAffordanceInner />;
}

function AcpConnectAffordanceInner() {
  const assistantId = useActiveAssistantId();
  const connection = useConnectClaude(assistantId);
  const [pastedCode, setPastedCode] = useState("");

  return (
    <div
      className="mt-2 space-y-3 rounded-lg border border-[var(--border-base)] p-3"
      data-testid="acp-connect-affordance"
    >
      <Typography
        variant="body-small-default"
        as="p"
        className="text-[var(--content-secondary)]"
      >
        Connect Claude Code to run this agent — sign in with your Claude account
        so no API key is needed.
      </Typography>

      <ConnectClaudePanel
        connection={connection}
        pastedCode={pastedCode}
        onPastedCodeChange={setPastedCode}
        pasteInstructions="After signing in, paste the code Claude shows you."
        connectedMessage="Claude Code connected. Ask again to run the agent."
      />
    </div>
  );
}
