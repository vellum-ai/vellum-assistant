import { Button, Typography } from "@vellumai/design-library";
import { useEffect, useRef, useState } from "react";

import { useTranslation } from "@/i18n";
import { usePointerCoarse } from "@/utils/pointer";

import { DesktopStatus } from "./desktop-status";
import type { DesktopEndReason } from "./desktop-connection";
import {
  openDesktopSession,
  type DesktopSessionState,
  type DesktopSession,
  type DesktopViewportMode,
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
  "busy",
]);

const VIEWPORT_MODES = [
  { mode: "fit", label: "assistantDesktop.fitView" },
  { mode: "pan", label: "assistantDesktop.panView" },
  { mode: "control", label: "assistantDesktop.controlView" },
] as const;

interface DesktopViewerProps {
  assistantId: string;
  viewOnly?: boolean;
}

/**
 * The interactive view of an assistant desktop. Opens a session on mount and
 * closes it on unmount. Touch viewers can pan a full-size desktop or fit it.
 * A status overlay covers the viewport until the picture is live, and again
 * once the session ends, with a Reconnect button where retrying can help.
 */
export function DesktopViewer({
  assistantId,
  viewOnly = false,
}: DesktopViewerProps) {
  const { t } = useTranslation("chat");
  const touch = usePointerCoarse();
  const [mobileMode, setMobileMode] = useState<DesktopViewportMode>("pan");
  const viewportMode = touch && !viewOnly ? mobileMode : "fit";
  const sessionRef = useRef<DesktopSession | null>(null);
  const viewOnlyRef = useRef(viewOnly);
  const viewportModeRef = useRef(viewportMode);
  useEffect(() => {
    viewOnlyRef.current = viewOnly;
    viewportModeRef.current = viewportMode;
    sessionRef.current?.setViewOnly(viewOnly);
    sessionRef.current?.setViewportMode(viewportMode);
  }, [viewOnly, viewportMode]);
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
      viewportMode: viewportModeRef.current,
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
    <div className="flex h-full w-full flex-col" data-testid="desktop-panel">
      {touch && !viewOnly && state.kind === "connected" && (
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 bg-[var(--surface-base)] p-2">
          {VIEWPORT_MODES.map(({ mode, label }) => (
            <Button
              size="large"
              key={mode}
              variant="ghost"
              active={mobileMode === mode}
              aria-pressed={mobileMode === mode}
              onClick={() => setMobileMode(mode)}
            >
              {t(label)}
            </Button>
          ))}
          {mobileMode === "pan" && (
            <Typography
              variant="body-small-default"
              className="w-full text-center text-[var(--content-secondary)]"
            >
              {t("assistantDesktop.panHint")}
            </Typography>
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className="h-full w-full overflow-hidden"
          data-testid="desktop-panel-viewport"
        />
        {state.kind === "connected" ? null : (
          <div
            className="absolute inset-0 bg-[var(--surface-base)]"
            data-testid="desktop-panel-status"
            data-state={state.kind === "ended" ? state.reason : state.kind}
          >
            <DesktopStatus
              loading={state.kind === "connecting"}
              message={
                state.kind === "connecting"
                  ? t("assistantDesktop.connecting")
                  : t(END_REASON_KEY[state.reason])
              }
            >
              {state.kind === "ended" &&
              RETRYABLE_END_REASONS.has(state.reason) ? (
                <Button variant="outlined" onClick={reconnect}>
                  {t("assistantDesktop.reconnectButton")}
                </Button>
              ) : null}
            </DesktopStatus>
          </div>
        )}
      </div>
    </div>
  );
}
