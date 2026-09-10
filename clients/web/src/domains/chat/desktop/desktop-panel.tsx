import { Button } from "@vellumai/design-library";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useTranslation } from "@/i18n";

import { useDesktopSetup } from "./use-desktop-setup";

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

export interface DesktopPanelProps {
  assistantId: string;
}

/**
 * The interactive view of an assistant desktop. Opens a session on mount and
 * closes it on unmount; noVNC resizes the remote display to fit the viewport.
 * A status overlay covers the viewport until the picture is live, and again
 * once the session ends, with a Reconnect button where retrying can help.
 */
export function DesktopViewer({ assistantId }: DesktopPanelProps) {
  const { t } = useTranslation("chat");
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

const SETUP_STAGE_KEY = {
  packages: "assistantDesktop.installingPackages",
  chrome: "assistantDesktop.installingChrome",
  checking: "assistantDesktop.checkingInstall",
} as const;

export function DesktopPanel({ assistantId }: DesktopPanelProps) {
  const { t } = useTranslation("chat");
  const { query, install } = useDesktopSetup(assistantId);
  const setup = query.data;
  if (setup?.state === "ready") {
    return <DesktopViewer key={assistantId} assistantId={assistantId} />;
  }
  const busy =
    query.isPending || install.isPending || setup?.state === "installing";
  const failed = query.isError || install.isError || setup?.state === "failed";
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
      role="status"
      aria-live="polite"
    >
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
      <p className="text-body-medium-lighter">
        {query.isError || install.isError
          ? t("assistantDesktop.setupRequestFailed")
          : failed
            ? t("assistantDesktop.installFailed")
            : setup?.state === "unsupported"
              ? t("assistantDesktop.setupUnsupported")
              : setup?.state === "installing"
                ? t(SETUP_STAGE_KEY[setup.stage ?? "packages"])
                : busy
                  ? t("assistantDesktop.checkingSetup")
                  : t("assistantDesktop.installDescription")}
      </p>
      {setup?.state === "installing" ? (
        <p className="text-body-small-lighter text-[var(--content-tertiary)]">
          {t("assistantDesktop.installBackground")}
        </p>
      ) : null}
      {query.isError || install.isError ? (
        <Button
          variant="outlined"
          onClick={() => {
            install.reset();
            void query.refetch();
          }}
        >
          {t("assistantDesktop.reconnectButton")}
        </Button>
      ) : setup?.state === "required" || setup?.state === "failed" ? (
        <Button
          variant="outlined"
          disabled={busy}
          onClick={() =>
            install.mutate({ path: { assistant_id: assistantId } })
          }
        >
          {t("assistantDesktop.installButton")}
        </Button>
      ) : null}
    </div>
  );
}
