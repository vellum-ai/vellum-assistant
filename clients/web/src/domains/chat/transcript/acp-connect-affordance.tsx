import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Typography } from "@vellumai/design-library/components/typography";
import { Loader2 } from "lucide-react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
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
  const { phase, error, connect, submitPastedCode } =
    useConnectClaude(assistantId);
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

      {phase === "idle" || phase === "error" ? (
        <Button variant="outlined" size="compact" onClick={() => void connect()}>
          Connect Claude Code
        </Button>
      ) : null}

      {phase === "starting" ? <BusyRow label="Starting sign-in..." /> : null}
      {phase === "awaiting_capture" ? (
        <BusyRow label="Waiting for Claude sign-in to complete..." />
      ) : null}
      {phase === "exchanging" ? <BusyRow label="Completing sign-in..." /> : null}

      {phase === "awaiting_paste" ? (
        <div className="space-y-2">
          <Typography
            variant="body-small-default"
            as="p"
            className="text-[var(--content-tertiary)]"
          >
            After signing in, paste the code Claude shows you.
          </Typography>
          <Input
            value={pastedCode}
            onChange={(e) => setPastedCode(e.target.value)}
            placeholder="Paste code here..."
            fullWidth
          />
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="compact"
              disabled={!pastedCode.trim()}
              onClick={() => void submitPastedCode(pastedCode)}
            >
              Complete Connection
            </Button>
          </div>
        </div>
      ) : null}

      {phase === "connected" ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--system-positive-strong)]"
        >
          Claude Code connected. Ask again to run the agent.
        </Typography>
      ) : null}

      {error ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--system-negative-strong)]"
        >
          {error}
        </Typography>
      ) : null}
    </div>
  );
}

function BusyRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
      <Typography
        variant="body-small-default"
        className="text-[var(--content-tertiary)]"
      >
        {label}
      </Typography>
    </div>
  );
}
