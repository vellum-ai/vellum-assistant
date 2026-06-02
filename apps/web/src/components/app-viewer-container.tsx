import { AlertTriangle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AppNavBar } from "@/components/app-nav-bar";
import { useSandboxFetchProxy } from "@/hooks/use-sandbox-fetch-proxy";
import type { AppCompileStatus } from "@/stores/viewer-store";
import { injectBridge } from "@/utils/sandbox-bridge";

export interface AppViewerContainerProps {
  appId: string;
  appName: string;
  html: string;
  assistantId: string;
  onClose: () => void;
  onEdit?: () => void;
  /** When true, the nav bar Edit button shows "Close chat" instead. */
  isEditing?: boolean;
  onShare?: () => void;
  isSharing?: boolean;
  onDeploy?: () => void;
  isDeploying?: boolean;
  /** Deep-link route passed to the app as `window.vellum.route`. */
  route?: string;
  /**
   * Live-build status from the daemon. Only `"error"` renders UI (a small
   * non-blocking badge over the last-good preview); `"building"`/`"ok"`/
   * undefined render nothing — the live iframe swap is the success feedback.
   */
  compileStatus?: AppCompileStatus;
  /** Compile diagnostics surfaced in the build-error badge. */
  buildErrors?: string[];
  /**
   * Generation counter bumped by the daemon on every successful recompile.
   * Folded into the iframe key so a bumped generation force-remounts the
   * preview even when `html` is byte-identical to the prior render.
   */
  reloadGeneration?: number;
}

/**
 * Non-blocking badge shown over the last-good preview when a recompile fails.
 * The iframe stays fully visible behind it (keep-last-good); the badge can be
 * dismissed and expanded to reveal the raw `buildErrors`.
 */
export function BuildErrorBadge({ buildErrors }: { buildErrors?: string[] }) {
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const errors = buildErrors ?? [];
  // The component stays mounted across successive `error` events (compileStatus
  // remains "error"), so a prior dismissal would otherwise hide every later,
  // DISTINCT build failure. Reset the dismissal when the error identity changes
  // so a new failure re-shows the badge.
  const errorKey = errors.join("\n");
  useEffect(() => {
    setDismissed(false);
  }, [errorKey]);
  if (dismissed) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2"
      role="status"
      aria-label="App build error"
    >
      <div
        className="pointer-events-auto max-w-full rounded-lg border px-3 py-2 shadow-sm"
        style={{
          background: "var(--surface-overlay)",
          borderColor: "var(--border-base)",
        }}
      >
        <div className="flex items-center gap-2 text-label-small-default">
          <AlertTriangle
            className="h-4 w-4 shrink-0 text-danger-500"
            aria-hidden
          />
          <span style={{ color: "var(--content-default)" }}>
            Build error — showing last working version
          </span>
          {errors.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="underline underline-offset-2"
              style={{ color: "var(--content-tertiary)" }}
            >
              {expanded ? "Hide details" : "Details"}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss build error"
            onClick={() => setDismissed(true)}
            className="ml-1 shrink-0"
            style={{ color: "var(--content-tertiary)" }}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {expanded && errors.length > 0 && (
          <pre
            className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-label-small-default"
            style={{ color: "var(--content-secondary)" }}
          >
            {errors.join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}

export function AppViewerContainer({
  appId,
  appName,
  html,
  assistantId,
  onClose,
  onEdit,
  isEditing,
  onShare,
  isSharing,
  onDeploy,
  isDeploying,
  route,
  compileStatus,
  buildErrors,
  reloadGeneration,
}: AppViewerContainerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const srcdoc = useMemo(
    () => injectBridge(html, appId, { fetch: true, route }),
    [html, appId, route],
  );

  const iframeKey = useMemo(() => {
    let hash = 0;
    for (let i = 0; i < html.length; i++) {
      hash = ((hash << 5) - hash + html.charCodeAt(i)) | 0;
    }
    return `app-${appId}-${reloadGeneration ?? 0}-${hash}`;
  }, [html, appId, reloadGeneration]);

  useSandboxFetchProxy(iframeRef, {
    frameId: appId,
    assistantId,
  });

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl bg-[var(--surface-base)]">
      <AppNavBar
        appName={appName}
        onEdit={onEdit}
        isEditing={isEditing}
        onShare={onShare}
        isSharing={isSharing}
        onDeploy={onDeploy}
        isDeploying={isDeploying}
        onClose={onClose}
      />

      <div className="relative min-h-0 flex-1">
        {compileStatus === "error" && (
          <BuildErrorBadge buildErrors={buildErrors} />
        )}
        <iframe
          ref={iframeRef}
          key={iframeKey}
          srcDoc={srcdoc}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          title={appName}
          className="h-full w-full border-none"
        />
      </div>
    </div>
  );
}
