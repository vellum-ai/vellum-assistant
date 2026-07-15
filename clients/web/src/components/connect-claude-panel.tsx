import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Typography } from "@vellumai/design-library/components/typography";
import { Loader2 } from "lucide-react";

import type { UseConnectClaudeResult } from "@/hooks/use-connect-claude";

// Shared "Connect Claude Code" phase-switch, driven by a `useConnectClaude`
// result. Rendered by both the settings section and the inline chat affordance;
// each supplies its own outer chrome and per-surface copy. Lives under
// `src/components/` so neither domain owns it (cross-domain imports are banned).
//
// Returns a fragment (no wrapper element) so its children stay direct children
// of the caller's `space-y-*` container and inherit the same vertical rhythm.

export interface ConnectClaudePanelProps {
  connection: UseConnectClaudeResult;
  pastedCode: string;
  onPastedCodeChange: (value: string) => void;
  /** Copy shown above the paste input on the manual/cloud path. */
  pasteInstructions: string;
  /** Copy shown once the flow reaches `connected`. */
  connectedMessage: string;
}

export function ConnectClaudePanel({
  connection: { phase, error, connect, submitPastedCode },
  pastedCode,
  onPastedCodeChange,
  pasteInstructions,
  connectedMessage,
}: ConnectClaudePanelProps) {
  return (
    <>
      {phase === "idle" || phase === "error" ? (
        <Button
          variant="outlined"
          size="compact"
          onClick={() => void connect()}
        >
          Connect Claude Code
        </Button>
      ) : null}

      {phase === "starting" ? <BusyRow label="Starting sign-in..." /> : null}
      {phase === "awaiting_capture" ? (
        <BusyRow label="Waiting for Claude sign-in to complete..." />
      ) : null}
      {phase === "exchanging" ? <BusyRow label="Completing sign-in..." /> : null}

      {phase === "awaiting_paste" ? (
        <div className="space-y-2">
          <Typography
            variant="body-small-default"
            as="p"
            className="text-[var(--content-secondary)]"
          >
            {pasteInstructions}
          </Typography>
          <Input
            value={pastedCode}
            onChange={(e) => onPastedCodeChange(e.target.value)}
            placeholder="Paste code here..."
            fullWidth
          />
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="compact"
              disabled={!pastedCode.trim()}
              onClick={() => void submitPastedCode(pastedCode)}
            >
              Complete Connection
            </Button>
          </div>
        </div>
      ) : null}

      {phase === "connected" ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--system-positive-strong)]"
        >
          {connectedMessage}
        </Typography>
      ) : null}

      {error ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--system-negative-strong)]"
        >
          {error}
        </Typography>
      ) : null}
    </>
  );
}

function BusyRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
      <Typography
        variant="body-small-default"
        className="text-[var(--content-tertiary)]"
      >
        {label}
      </Typography>
    </div>
  );
}
