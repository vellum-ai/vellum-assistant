import { Button } from "@vellumai/design-library";
import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useTranslation } from "@/i18n";

import {
  openDesktopSession,
  type DesktopSessionOptions,
  type DesktopSessionState,
} from "./desktop-session";

export interface DesktopPanelProps {
  assistantId: string;
  /** Test seams, threaded through to {@link openDesktopSession}. */
  sessionOptions?: DesktopSessionOptions;
}

/**
 * The interactive view of a pod desktop.
 *
 * Opens a session on mount and closes it on unmount; the viewport fills
 * whatever box it is given, and noVNC resizes the remote display to match.
 * Everything but a live picture is drawn over the viewport: a spinner while
 * connecting, and once the session ends, why it ended and (where retrying
 * can help) a way to reconnect.
 */
export function DesktopPanel({
  assistantId,
  sessionOptions,
}: DesktopPanelProps) {
  const { t } = useTranslation("chat");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<DesktopSessionState>({
    kind: "connecting",
  });
  // Bumped by Reconnect; the effect below reopens the session on each change.
  const [attempt, setAttempt] = useState(0);

  const optionsRef = useRef(sessionOptions);
  useLayoutEffect(() => {
    optionsRef.current = sessionOptions;
  }, [sessionOptions]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const session = openDesktopSession({
      assistantId,
      container,
      onState: setState,
      options: optionsRef.current,
    });
    return () => session.close();
  }, [assistantId, attempt]);

  const reconnect = (): void => {
    setState({ kind: "connecting" });
    setAttempt((n) => n + 1);
  };

  return (
    <div className="relative h-full w-full" data-testid="desktop-panel">
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden bg-black"
        data-testid="desktop-panel-viewport"
      />
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
                {t("podDesktop.connecting")}
              </span>
            </>
          ) : (
            <>
              <span className="text-body-medium-lighter">
                {state.reason === "busy"
                  ? t("podDesktop.busy")
                  : state.reason === "unavailable"
                    ? t("podDesktop.unavailable")
                    : state.reason === "failed"
                      ? t("podDesktop.failed")
                      : t("podDesktop.lost")}
              </span>
              {state.reason === "failed" || state.reason === "lost" ? (
                <Button variant="outlined" onClick={reconnect}>
                  {t("podDesktop.reconnectButton")}
                </Button>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
