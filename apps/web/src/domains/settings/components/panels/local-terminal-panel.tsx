/**
 * Local terminal tab for the Debug settings panel. Renders a PTY shell
 * connected to the user's local machine via the Electron `node-pty`
 * bridge. Only visible inside the Electron desktop shell — the tab is
 * filtered out on web/iOS by the parent `DebugPage`.
 */

import { Terminal } from "lucide-react";

import { LocalTerminalPanel as LocalTerminalPanelShared } from "@/components/local-terminal-panel";
import { isElectron } from "@/runtime/is-electron";
import { Notice } from "@vellumai/design-library/components/notice";

export function LocalTerminalPanel() {
  if (!isElectron()) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--surface-base)]">
            <Terminal className="h-5 w-5 text-[var(--content-secondary)]" />
          </div>
          <div>
            <h2 className="text-title-small text-[var(--content-default)]">
              Local Terminal
            </h2>
            <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
              Interactive shell session on your local machine
            </p>
          </div>
        </div>
        <Notice tone="info">
          Local terminal is only available in the desktop app.
        </Notice>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--surface-base)]">
          <Terminal className="h-5 w-5 text-[var(--content-secondary)]" />
        </div>
        <div>
          <h2 className="text-title-small text-[var(--content-default)]">
            Local Terminal
          </h2>
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            Interactive shell session on your local machine
          </p>
        </div>
      </div>
      <LocalTerminalPanelShared className="min-h-0 flex-1" />
    </div>
  );
}
