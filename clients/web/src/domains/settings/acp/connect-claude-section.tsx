import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ConnectClaudePanel } from "@/components/connect-claude-panel";
import { useConnectClaude } from "@/hooks/use-connect-claude";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

// ---------------------------------------------------------------------------
// Connect Claude Code section
// ---------------------------------------------------------------------------
//
// Settings surface for the ACP "Connect Claude" OAuth flow. Gated behind the
// `acp-claude-oauth-connect` flag. Desktop is one-click (loopback poll); the
// cloud is one-paste (manual exchange). See `useConnectClaude`.

export function ConnectClaudeSection() {
  const enabled = useAssistantFeatureFlagStore.use.acpClaudeOauthConnect();
  if (!enabled) {
    return null;
  }
  return <ConnectClaudeSectionInner />;
}

function ConnectClaudeSectionInner() {
  const assistantId = useActiveAssistantId();
  const connection = useConnectClaude(assistantId);
  const { phase, reset } = connection;
  const [pastedCode, setPastedCode] = useState("");

  function handleReset() {
    reset();
    setPastedCode("");
  }

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border-base)] p-4">
      <div className="space-y-1">
        <Typography
          variant="title-small"
          as="p"
          className="text-[var(--content-default)]"
        >
          Connect Claude Code
        </Typography>
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--content-tertiary)]"
        >
          Sign in with your Claude account so your assistant can run Claude Code
          agents without pasting an API key.
        </Typography>
      </div>

      <ConnectClaudePanel
        connection={connection}
        pastedCode={pastedCode}
        onPastedCodeChange={setPastedCode}
        pasteInstructions="After signing in, copy the code Claude shows you and paste it below."
        connectedMessage="Claude Code connected."
      />

      {phase === "connected" ? (
        <Button variant="ghost" size="compact" onClick={handleReset}>
          Connect a different account
        </Button>
      ) : null}
    </div>
  );
}
