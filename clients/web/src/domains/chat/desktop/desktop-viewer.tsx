import { Button } from "@vellumai/design-library";
import { Loader2, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useTranslation } from "@/i18n";

import { DesktopAppsPanel } from "./desktop-apps-panel";
import type { DesktopEndReason } from "./desktop-connection";
import {
  openDesktopSession,
  type DesktopSessionState,
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
}

/**
 * The interactive view of an assistant desktop. Opens a session on mount and
 * closes it on unmount; noVNC resizes the remote display to fit the viewport.
 * A status overlay covers the viewport until the picture is live, and again
 * once the session ends, with a Reconnect button where retrying can help.
 */
export function DesktopViewer({ assistantId }: DesktopViewerProps) {
  const { t } = useTranslation("chat");
  const [appsOpen, setAppsOpen] = useState(false);
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
    });
    return () => session.close();
  }, [assistantId, attempt]);

  const reconnect = (): void => {
    setState({ kind: "connecting" });
    setAttempt((n) => n + 1);
  };

  return (
    <div className="flex h-full w-full flex-col" data-testid="desktop-panel">
      <div className="flex shrink-0 justify-end border-b border-[var(--border-subtle)] p-2">
        <Button
          variant="outlined"
          aria-expanded={appsOpen}
          onClick={() => setAppsOpen((open) => !open)}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t(appsOpen ? "desktopApps.back" : "desktopApps.title")}
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
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
        {appsOpen ? (
          <div className="absolute inset-y-0 right-0 w-full max-w-sm border-l border-[var(--border-subtle)] bg-[var(--surface-base)] text-[var(--content-default)] shadow-xl">
            <DesktopAppsPanel
              key={assistantId}
              assistantId={assistantId}
              connected={state.kind === "connected"}
              onOpened={() => setAppsOpen(false)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
