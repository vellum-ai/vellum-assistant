import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ConnectClaudePanel } from "@/components/connect-claude-panel";
import { AcpAgentIcon } from "@/domains/chat/components/acp-run-inline-card/acp-agent-icon";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { isClaudeConnected } from "@/hooks/connect-claude-api";
import { useConnectClaude } from "@/hooks/use-connect-claude";
import { useSupportsAcpConnect } from "@/lib/backwards-compat/use-supports-acp-connect";

// ---------------------------------------------------------------------------
// Inline "Connect Claude Code" affordance for a failed ACP spawn
// ---------------------------------------------------------------------------
//
// When an `acp_spawn` fails because the `claude-agent-acp` OAuth token is
// missing, the live `tool_result` carries a structured `errorCode` marker
// (`ACP_CLAUDE_OAUTH_MISSING_CODE`) that the stream handler promotes into the
// interaction store (`pendingAcpConnect`). The transcript renders this inline
// affordance under the failed tool call's group so the user can complete the
// OAuth flow in one round-trip instead of reading dead error text and running a
// CLI prompt. Because the prompt lives in the store — not on the reseed-able
// tool-call field — it survives the routine `/messages` resync instead of
// vanishing mid-turn. Gated on the daemon being new enough to serve the Connect
// auth routes (see `useSupportsAcpConnect`); against an older daemon the
// component renders nothing and the tool call keeps its plain error rendering.

export function AcpConnectAffordance() {
  const supported = useSupportsAcpConnect();
  if (!supported) {
    // Daemon too old to serve the Connect routes → plain error rendering.
    return null;
  }
  return <AcpConnectAffordanceInner />;
}

function AcpConnectAffordanceInner() {
  const assistantId = useActiveAssistantId();
  const connection = useConnectClaude(assistantId);
  const [pastedCode, setPastedCode] = useState("");
  const [alreadyConnected, setAlreadyConnected] = useState(false);

  // Self-heal: if Claude is already connected (e.g. connected from Settings out
  // of band), the store-held prompt is stale — retire it rather than show a CTA
  // for something already done. Best-effort: a thrown check (an older daemon
  // without the route) is treated as "unknown" and leaves the prompt in place.
  // Only acts while the user hasn't started a flow in this card (`phase` still
  // `idle`), so a fresh in-card connect keeps showing its "connected"
  // confirmation instead of unmounting out from under the user.
  useEffect(() => {
    let cancelled = false;
    void isClaudeConnected(assistantId)
      .then((connected) => {
        if (!cancelled && connected) {
          setAlreadyConnected(true);
        }
      })
      .catch(() => {
        // Ignore — leave the prompt in place when the check is unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [assistantId]);

  useEffect(() => {
    if (alreadyConnected && connection.phase === "idle") {
      useInteractionStore.getState().dismissAcpConnect();
    }
  }, [alreadyConnected, connection.phase]);

  if (alreadyConnected && connection.phase === "idle") {
    return null;
  }

  return (
    <div
      className="mt-2 rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)] p-4"
      data-testid="acp-connect-affordance"
    >
      <div className="flex gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)]">
          <AcpAgentIcon agent="claude" className="h-7 w-7 shrink-0" />
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <div className="min-w-0">
            <div className="text-title-small text-[var(--content-strong)]">
              Connect Claude Code
            </div>
            <p className="mt-1 text-body-medium-lighter text-[var(--content-quiet)]">
              Sign in with your Claude account to run this agent — no API key
              needed.
            </p>
          </div>

          <ConnectClaudePanel
            connection={connection}
            pastedCode={pastedCode}
            onPastedCodeChange={setPastedCode}
            pasteInstructions="After signing in, paste the code Claude shows you."
            connectedMessage="Claude Code connected. Ask again to run the agent."
          />
        </div>

        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => useInteractionStore.getState().dismissAcpConnect()}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center self-start rounded-md text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-strong)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
