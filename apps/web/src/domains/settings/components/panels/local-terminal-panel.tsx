/**
 * Local terminal tab for the Debug settings panel. Opens an interactive shell
 * in a *self-hosted* assistant's workspace via the Electron `node-pty` bridge
 * (which runs `vellum exec -it`). Only visible inside the Electron desktop
 * shell and only for self-hosted assistants — the tab is filtered out on
 * web/iOS and for platform-hosted assistants by the parent `DebugPage`, which
 * uses the platform "Terminal" tab instead.
 */

import { Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { getAssistant } from "@/assistant/api";
import { LocalTerminalPanel as LocalTerminalPanelShared } from "@/components/local-terminal-panel";
import { captureError } from "@/lib/sentry/capture-error";
import { isElectron } from "@/runtime/is-electron";
import { toast } from "@vellumai/design-library";
import { Notice } from "@vellumai/design-library/components/notice";

function PanelHeader() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--surface-base)]">
        <Terminal className="h-5 w-5 text-[var(--content-secondary)]" />
      </div>
      <div>
        <h2 className="text-title-small text-[var(--content-default)]">
          Local Terminal
        </h2>
        <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
          Interactive shell session in your assistant's workspace
        </p>
      </div>
    </div>
  );
}

export function LocalTerminalPanel() {
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [isSelfHosted, setIsSelfHosted] = useState(false);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  const fetchAssistant = useCallback(async () => {
    if (fetchedRef.current) return;
    try {
      const result = await getAssistant();
      if (result.ok) {
        fetchedRef.current = true;
        setAssistantId(result.data.id);
        setIsSelfHosted(result.data.is_local);
      }
    } catch (error) {
      captureError(error, { context: "fetch_assistant_for_local_terminal" });
      toast.error("Failed to load assistant info");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isElectron()) {
      setLoading(false);
      return;
    }
    void fetchAssistant();
  }, [fetchAssistant]);

  let body: React.ReactNode;
  if (!isElectron()) {
    body = (
      <Notice tone="info">
        Local terminal is only available in the desktop app.
      </Notice>
    );
  } else if (loading) {
    body = (
      <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--border-element)] border-t-[var(--content-secondary)]" />
        Loading terminal...
      </div>
    );
  } else if (!assistantId || !isSelfHosted) {
    body = (
      <Notice tone="info">
        The local terminal opens a shell in a self-hosted assistant's workspace.
        Platform-hosted assistants use the Terminal tab instead.
      </Notice>
    );
  } else {
    body = (
      <LocalTerminalPanelShared
        assistantId={assistantId}
        className="min-h-0 flex-1"
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PanelHeader />
      {body}
    </div>
  );
}
