import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Check, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { AcpAgentIcon } from "@/domains/chat/components/acp-run-inline-card/acp-agent-icon";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { isClaudeConnected } from "@/hooks/connect-claude-api";
import {
  useConnectClaude,
  type UseConnectClaudeResult,
} from "@/hooks/use-connect-claude";
import { useSupportsAcpConnect } from "@/lib/backwards-compat/use-supports-acp-connect";
import { isElectron } from "@/runtime/is-electron";

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
//
// The transcript's own `assistantId` is passed in (rather than read via
// `useActiveAssistantId()`, which throws outside `ActiveAssistantGate` — and
// `ChatPage` renders outside it): a transcript row can render during a
// self-hosted/transition state before the active id resolves, so we take the
// (nullable) prop and render nothing when it's absent.
//
// Two card shapes, chosen the same way the client tells the daemon which flow to
// run (`preferManual: !isElectron()`), so the shape matches the flow the user
// gets:
//   - one-step (desktop/loopback): a compact row — the daemon captures the token
//     on its own callback, so a single "Connect" click is the whole flow.
//   - two-step (browser/cloud): a stacked card — "Connect" opens a tab, then the
//     user pastes the key it shows back into a masked field to finish.

export function AcpConnectAffordance({
  assistantId,
}: {
  assistantId: string | null | undefined;
}) {
  const supported = useSupportsAcpConnect();
  if (!supported || !assistantId) {
    // Daemon too old to serve the Connect routes, or no active assistant yet →
    // plain error rendering.
    return null;
  }
  return <AcpConnectAffordanceInner assistantId={assistantId} />;
}

function AcpConnectAffordanceInner({ assistantId }: { assistantId: string }) {
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

  const dismiss = () => useInteractionStore.getState().dismissAcpConnect();

  return isElectron() ? (
    <OneStepCard connection={connection} onDismiss={dismiss} />
  ) : (
    <TwoStepCard
      connection={connection}
      pastedCode={pastedCode}
      onPastedCodeChange={setPastedCode}
      onDismiss={dismiss}
    />
  );
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

function BrandIcon() {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)]">
      <AcpAgentIcon agent="claude" className="h-5 w-5 shrink-0" />
    </div>
  );
}

function Title() {
  return (
    <div className="text-title-small text-[var(--content-strong)]">
      Connect Claude Code
    </div>
  );
}

function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button
      type="button"
      aria-label="Dismiss"
      title="Dismiss"
      onClick={onDismiss}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-strong)]"
    >
      <X className="h-4 w-4" />
    </button>
  );
}

function BusyRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
      <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One-step (desktop / loopback): compact single row
// ---------------------------------------------------------------------------

function OneStepCard({
  connection,
  onDismiss,
}: {
  connection: UseConnectClaudeResult;
  onDismiss: () => void;
}) {
  const { phase, error, connect } = connection;

  const subtitle =
    phase === "error"
      ? (error ?? "Connecting Claude failed. Please try again.")
      : phase === "starting"
        ? "Starting sign-in..."
        : phase === "awaiting_capture" || phase === "awaiting_paste"
          ? "Waiting for Claude sign-in..."
          : phase === "exchanging"
            ? "Completing sign-in..."
            : phase === "connected"
              ? "Claude Code connected. Ask again to run the agent."
              : "Sign in — no API key needed";

  const subtitleColor =
    phase === "error"
      ? "text-[var(--system-negative-strong)]"
      : phase === "connected"
        ? "text-[var(--system-positive-strong)]"
        : "text-[var(--content-quiet)]";

  const canConnect = phase === "idle" || phase === "error";
  const busy =
    phase === "starting" ||
    phase === "awaiting_capture" ||
    phase === "awaiting_paste" ||
    phase === "exchanging";

  return (
    <div
      data-testid="acp-connect-affordance"
      className="mt-2 flex items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-base)] px-3 py-2.5 shadow-sm"
    >
      <BrandIcon />
      <div className="min-w-0 flex-1">
        <Title />
        <div className={`text-body-medium-lighter ${subtitleColor}`}>
          {subtitle}
        </div>
      </div>

      {canConnect ? (
        <Button variant="primary" size="compact" onClick={() => void connect()}>
          Connect
        </Button>
      ) : busy ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--content-tertiary)]" />
      ) : phase === "connected" ? (
        <Check className="h-5 w-5 shrink-0 text-[var(--system-positive-strong)]" />
      ) : null}

      <DismissButton onDismiss={onDismiss} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Two-step (browser / cloud): stacked card with a paste step
// ---------------------------------------------------------------------------

function TwoStepCard({
  connection,
  pastedCode,
  onPastedCodeChange,
  onDismiss,
}: {
  connection: UseConnectClaudeResult;
  pastedCode: string;
  onPastedCodeChange: (value: string) => void;
  onDismiss: () => void;
}) {
  const { phase, error, connect, submitPastedCode } = connection;

  return (
    <div
      data-testid="acp-connect-affordance"
      className="mt-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-base)] p-4 shadow-sm"
    >
      <div className="flex items-center gap-3">
        <BrandIcon />
        <div className="min-w-0 flex-1">
          <Title />
        </div>
        <DismissButton onDismiss={onDismiss} />
      </div>

      <div className="mt-3 space-y-3">
        {phase === "idle" || phase === "error" ? (
          <>
            <p
              className={`text-body-medium-lighter ${
                phase === "error"
                  ? "text-[var(--system-negative-strong)]"
                  : "text-[var(--content-quiet)]"
              }`}
            >
              {phase === "error"
                ? (error ?? "Connecting Claude failed. Please try again.")
                : "Sign in with your Claude account to run this agent. No API key required."}
            </p>
            <Button variant="primary" fullWidth onClick={() => void connect()}>
              Connect
            </Button>
          </>
        ) : null}

        {phase === "starting" ? <BusyRow label="Starting sign-in..." /> : null}
        {phase === "awaiting_capture" ? (
          <BusyRow label="Waiting for Claude sign-in..." />
        ) : null}
        {phase === "exchanging" ? (
          <BusyRow label="Completing sign-in..." />
        ) : null}

        {phase === "awaiting_paste" ? (
          <>
            <p className="text-body-medium-lighter text-[var(--content-quiet)]">
              A browser tab opened. Paste the key it gives you to finish.
            </p>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  type="password"
                  value={pastedCode}
                  onChange={(e) => onPastedCodeChange(e.target.value)}
                  placeholder="Paste your key"
                  fullWidth
                />
              </div>
              <Button
                variant="primary"
                disabled={!pastedCode.trim()}
                onClick={() => void submitPastedCode(pastedCode)}
              >
                Save
              </Button>
            </div>
          </>
        ) : null}

        {phase === "connected" ? (
          <p className="text-body-medium-lighter text-[var(--system-positive-strong)]">
            Claude Code connected. Ask again to run the agent.
          </p>
        ) : null}
      </div>
    </div>
  );
}
