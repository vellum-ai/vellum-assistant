import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Typography } from "@vellumai/design-library/components/typography";
import { Loader2 } from "lucide-react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useConnectClaude } from "./use-connect-claude";

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
  const { phase, error, connect, submitPastedCode, reset } =
    useConnectClaude(assistantId);
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

      {phase === "idle" || phase === "error" ? (
        <Button
          variant="outlined"
          size="compact"
          onClick={() => void connect()}
        >
          Connect Claude Code
        </Button>
      ) : null}

      {phase === "starting" ? <BusyRow label="Starting sign-in..." /> : null}
      {phase === "awaiting_capture" ? (
        <BusyRow label="Waiting for Claude sign-in to complete..." />
      ) : null}
      {phase === "exchanging" ? (
        <BusyRow label="Completing sign-in..." />
      ) : null}

      {phase === "awaiting_paste" ? (
        <div className="space-y-3">
          <Typography
            variant="body-small-default"
            as="p"
            className="text-[var(--content-secondary)]"
          >
            After signing in, copy the code Claude shows you and paste it below.
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
          Claude Code connected.
        </Typography>
      ) : null}

      {error ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-(--system-negative-strong)"
        >
          {error}
        </Typography>
      ) : null}

      {phase === "connected" ? (
        <Button variant="ghost" size="compact" onClick={handleReset}>
          Connect a different account
        </Button>
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
