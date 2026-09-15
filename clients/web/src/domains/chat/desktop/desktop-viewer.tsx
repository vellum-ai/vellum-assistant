import { Button } from "@vellumai/design-library";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useTranslation } from "@/i18n";

import type { DesktopEndReason } from "./desktop-connection";
import {
  openDesktopSession,
  type DesktopSessionState,
  type DesktopSession,
} from "./desktop-session";

// Spelled out rather than templated so the catalog-usage guard sees each key.
const END_REASON_KEY = {
  busy: "assistantDesktop.busy",
  unavailable: "assistantDesktop.unavailable",
  failed: "assistantDesktop.failed",
  lost: "assistantDesktop.lost",
} as const satisfies Record<DesktopEndReason, string>;

/** Endings a fresh session might get past. */
const RETRYABLE_END_REASONS: ReadonlySet<DesktopEndReason> = new Set([
  "failed",
  "lost",
]);

interface DesktopViewerProps {
  assistantId: string;
  viewOnly?: boolean;
  onExpand?: () => void;
}

/**
 * The interactive view of an assistant desktop. Opens a session on mount and
 * closes it on unmount; noVNC scales the whole desktop to fit the viewport.
 * A status overlay covers the viewport until the picture is live, and again
 * once the session ends, with a Reconnect button where retrying can help.
 */
export function DesktopViewer({ assistantId, viewOnly = false, onExpand }: DesktopViewerProps) {
  const { t } = useTranslation("chat");
  const sessionRef = useRef<DesktopSession | null>(null);
  const viewOnlyRef = useRef(viewOnly);
  useEffect(() => {
    viewOnlyRef.current = viewOnly;
    sessionRef.current?.setViewOnly(viewOnly);
  }, [viewOnly]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<DesktopSessionState>({
    kind: "connecting",
  });
  // Bumped by Reconnect; the effect below reopens the session on each change.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const session = openDesktopSession({
      assistantId,
      container,
      onState: setState,
      viewOnly: viewOnlyRef.current,
    });
    sessionRef.current = session;
    return () => {
      sessionRef.current = null;
      session.close();
    };
  }, [assistantId, attempt]);

  const reconnect = (): void => {
    setState({ kind: "connecting" });
    setAttempt((n) => n + 1);
  };

  return (
    <div className="relative h-full w-full" data-testid="desktop-panel">
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden [&_canvas]:rounded-lg"
        data-testid="desktop-panel-viewport"
      />
      {state.kind === "connected" && viewOnly && onExpand ? (
        <Button
          variant="ghost"
          aria-label={t("assistantDesktop.expandAria")}
          onClick={onExpand}
          className="absolute inset-0 h-full w-full cursor-zoom-in rounded-none bg-transparent hover:bg-transparent"
        />
      ) : null}
      {state.kind === "connected" ? null : (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--surface-base)] text-[var(--content-default)]"
          data-testid="desktop-panel-status"
          data-state={state.kind === "ended" ? state.reason : state.kind}
        >
          {state.kind === "connecting" ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin text-[var(--content-tertiary)]" />
              <span className="text-body-medium-lighter">
                {t("assistantDesktop.connecting")}
              </span>
            </>
          ) : (
            <>
              <span className="text-body-medium-lighter">
                {t(END_REASON_KEY[state.reason])}
              </span>
              {RETRYABLE_END_REASONS.has(state.reason) ? (
                <Button variant="outlined" onClick={reconnect}>
                  {t("assistantDesktop.reconnectButton")}
                </Button>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
