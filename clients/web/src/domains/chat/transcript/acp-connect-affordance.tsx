import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Check, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AcpAgentIcon } from "@/domains/chat/components/acp-run-inline-card/acp-agent-icon";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { isClaudeConnected } from "@/hooks/connect-claude-api";
import {
  useConnectClaude,
  type UseConnectClaudeResult,
} from "@/hooks/use-connect-claude";
import { useTranslation } from "@/i18n";
import { useSupportsAcpConnect } from "@/lib/backwards-compat/use-supports-acp-connect";
import { recordLifecycleDiagnostic } from "@/lib/diagnostics";
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
//   - one-step (desktop/loopback): the daemon captures the token on its own
//     callback, so a single "Connect" click is the whole flow.
//   - two-step (browser/cloud): "Connect" opens a tab, then the user pastes the
//     key it shows back into a masked field to finish.

export function AcpConnectAffordance({
  assistantId,
}: {
  assistantId: string | null | undefined;
}) {
  const supported = useSupportsAcpConnect(assistantId);
  if (!supported || !assistantId) {
    // This assistant's daemon is too old to serve the Connect routes (scoped to
    // the rendered assistant so a version-skew switch can't 404), or no active
    // assistant yet → plain error rendering.
    return null;
  }
  return <AcpConnectAffordanceInner assistantId={assistantId} />;
}

function AcpConnectAffordanceInner({ assistantId }: { assistantId: string }) {
  const connection = useConnectClaude(assistantId);
  const [pastedCode, setPastedCode] = useState("");
  const [alreadyConnected, setAlreadyConnected] = useState(false);
  const reason = useInteractionStore(
    (state) => state.pendingAcpConnect?.reason ?? "missing",
  );

  // Self-heal: if Claude is already connected (e.g. connected from Settings out
  // of band), the store-held prompt is stale — retire it rather than show a CTA
  // for something already done. Best-effort: a thrown check (an older daemon
  // without the route) is treated as "unknown" and leaves the prompt in place.
  // Only acts while the user hasn't started a flow in this card (`phase` still
  // `idle`), so a fresh in-card connect keeps showing its "connected"
  // confirmation instead of unmounting out from under the user.
  //
  // Skipped for an `auth_required` prompt: that check asks "is a token
  // stored", the wrong question when the stored token itself was rejected. A
  // "yes" would retire the card over the failure it exists to repair; those
  // prompts clear only by completing the connect flow.
  useEffect(() => {
    if (reason === "auth_required") {
      return;
    }
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
  }, [assistantId, reason]);

  useEffect(() => {
    if (!alreadyConnected || connection.phase !== "idle") {
      return;
    }
    // Leave a breadcrumb: the card flashing and vanishing is otherwise silent,
    // and a self-heal dismissal next to a fresh missing-token failure is the
    // signature of a status/spawn predicate mismatch. It goes in the durable
    // lifecycle ring because streaming floods the high-volume ring, which then
    // evicts within minutes, and the breadcrumb has to survive until a feedback
    // bundle is captured.
    const store = useInteractionStore.getState();
    recordLifecycleDiagnostic("acp_connect_self_heal_dismiss", {
      assistantId,
      toolUseId: store.pendingAcpConnect?.toolUseId ?? null,
      reason: store.pendingAcpConnect?.reason ?? "missing",
    });
    store.dismissAcpConnect();
  }, [alreadyConnected, assistantId, connection.phase]);

  // When the in-card connect flow completes, signal the chat view to
  // auto-continue the failed task (via a hidden "retry" send) so the user
  // doesn't have to re-ask. One-shot — the continuation's own send clears the
  // card, but guard so a re-render can't re-trigger it.
  const continuedRef = useRef(false);
  useEffect(() => {
    if (connection.phase === "connected" && !continuedRef.current) {
      continuedRef.current = true;
      useInteractionStore.getState().requestAcpContinue();
    }
  }, [connection.phase]);

  if (alreadyConnected && connection.phase === "idle") {
    return null;
  }

  // The daemon has the final say on loopback (one-step) vs manual (two-step): a
  // containerized/cloud assistant forces manual even in the desktop app, whose
  // localhost callback can't reach the pod. So once the flow starts and the
  // daemon reports its `mode`, trust that; before the first click, guess from
  // the host (`isElectron()` ⇒ likely loopback). The guess self-corrects the
  // instant `mode` resolves, so the desktop app on a cloud assistant lands on
  // the paste step instead of a dead one-step "waiting" state with no input.
  const oneStep = connection.mode
    ? connection.mode === "loopback"
    : isElectron();

  return oneStep ? (
    <OneStepCard connection={connection} />
  ) : (
    <TwoStepCard
      connection={connection}
      pastedCode={pastedCode}
      onPastedCodeChange={setPastedCode}
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
  const { t } = useTranslation("chat");
  return (
    <div className="text-title-small text-[var(--content-strong)]">
      {t("acpConnectAffordance.title")}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One-step (desktop / loopback): compact single row
// ---------------------------------------------------------------------------

// Exported (with TwoStepCard) for Storybook, which drives the pure-props cards
// directly; production callers stay within this file.
export function OneStepCard({
  connection,
}: {
  connection: UseConnectClaudeResult;
}) {
  const { phase, error, connect } = connection;
  const { t } = useTranslation("chat");

  const subtitle =
    phase === "error"
      ? (error ?? t("acpConnectAffordance.errorFallback"))
      : phase === "starting"
        ? t("acpConnectAffordance.subtitleStarting")
        : phase === "awaiting_capture" || phase === "awaiting_paste"
          ? t("acpConnectAffordance.subtitleWaiting")
          : phase === "exchanging"
            ? t("acpConnectAffordance.subtitleExchanging")
            : phase === "connected"
              ? t("acpConnectAffordance.subtitleConnected")
              : t("acpConnectAffordance.subtitleIdle");

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
        <Button variant="primary" onClick={() => void connect()}>
          {t("acpConnectAffordance.connectButton")}
        </Button>
      ) : busy ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--content-tertiary)]" />
      ) : phase === "connected" ? (
        <Check className="h-5 w-5 shrink-0 text-[var(--system-positive-strong)]" />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Two-step (browser / cloud): the same compact row, plus a paste step
// ---------------------------------------------------------------------------

export function TwoStepCard({
  connection,
  pastedCode,
  onPastedCodeChange,
}: {
  connection: UseConnectClaudeResult;
  pastedCode: string;
  onPastedCodeChange: (value: string) => void;
}) {
  const { phase, error, connect, submitPastedCode } = connection;
  const { t } = useTranslation("chat");

  // A failed exchange (bad/expired code, 400) returns to `awaiting_paste` with
  // an error set; surface it in the subtitle so Save doesn't look like a no-op.
  // The input keeps its value for a retry.
  const subtitle =
    phase === "error"
      ? (error ?? t("acpConnectAffordance.errorFallback"))
      : phase === "starting"
        ? t("acpConnectAffordance.subtitleStarting")
        : phase === "awaiting_capture"
          ? t("acpConnectAffordance.subtitleWaiting")
          : phase === "exchanging"
            ? t("acpConnectAffordance.subtitleExchanging")
            : phase === "awaiting_paste"
              ? (error ?? t("acpConnectAffordance.subtitlePaste"))
              : phase === "connected"
                ? t("acpConnectAffordance.subtitleConnected")
                : t("acpConnectAffordance.subtitleIdle");

  const subtitleColor =
    phase === "error" || (phase === "awaiting_paste" && error)
      ? "text-[var(--system-negative-strong)]"
      : phase === "connected"
        ? "text-[var(--system-positive-strong)]"
        : "text-[var(--content-quiet)]";

  const canConnect = phase === "idle" || phase === "error";
  const busy =
    phase === "starting" ||
    phase === "awaiting_capture" ||
    phase === "exchanging";

  return (
    <div
      data-testid="acp-connect-affordance"
      className="mt-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-base)] px-3 py-2.5 shadow-sm"
    >
      <div className="flex items-center gap-3">
        <BrandIcon />
        <div className="min-w-0 flex-1">
          <Title />
          <div className={`text-body-medium-lighter ${subtitleColor}`}>
            {subtitle}
          </div>
        </div>

        {canConnect ? (
          <Button variant="primary" onClick={() => void connect()}>
            {t("acpConnectAffordance.connectButton")}
          </Button>
        ) : busy ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--content-tertiary)]" />
        ) : phase === "connected" ? (
          <Check className="h-5 w-5 shrink-0 text-[var(--system-positive-strong)]" />
        ) : null}
      </div>

      {phase === "awaiting_paste" ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Input
              type="password"
              value={pastedCode}
              onChange={(e) => onPastedCodeChange(e.target.value)}
              placeholder={t("acpConnectAffordance.pastePlaceholder")}
              fullWidth
            />
          </div>
          <Button
            variant="primary"
            disabled={!pastedCode.trim()}
            onClick={() => void submitPastedCode(pastedCode)}
          >
            {t("acpConnectAffordance.saveButton")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
