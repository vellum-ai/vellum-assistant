
import { Loader2, PlugZap, Terminal, Unplug, Wrench, X } from "lucide-react";

import { Button } from "@vellum/design-library/components/button";
import { Tag, type TagTone } from "@vellum/design-library/components/tag";

import type { TerminalStatus } from "@/components/shared/terminal/types.js";

interface TerminalToolbarProps {
  status: TerminalStatus;
  /** Called when the user clicks "Connect". */
  onConnect: () => void;
  /** Called when the user clicks "Disconnect". */
  onDisconnect: () => void;
  /** Called when the user clicks "Clear". */
  onClear: () => void;
  /** Optional CSS class for the outer toolbar element. */
  className?: string;
  /**
   * When true, show a maintenance mode indicator in the toolbar title area
   * to make clear the session will target a debug pod.
   */
  maintenanceModeActive?: boolean;
}

/**
 * TerminalToolbar renders connect/disconnect/clear action buttons together
 * with a status badge that reflects the current terminal session state.
 */
export function TerminalToolbar({
  status,
  onConnect,
  onDisconnect,
  onClear,
  className,
  maintenanceModeActive,
}: TerminalToolbarProps) {
  const isConnecting = status === "connecting" || status === "reconnecting";
  const isConnected = status === "connected";
  const canConnect = status === "idle" || status === "closed" || status === "error";

  return (
    <div
      className={[
        "flex items-center justify-between gap-3 px-3 py-1.5 border-b",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ background: "var(--surface-lift)", borderColor: "var(--border-base)" }}
    >
      {/* Left: terminal icon + title */}
      <div className="flex items-center gap-2 min-w-0">
        <Terminal className="h-4 w-4 shrink-0" style={{ color: "var(--content-tertiary)" }} />
        <span className="text-body-medium-default truncate" style={{ color: "var(--content-secondary)" }}>
          Terminal
        </span>
        <StatusBadge status={status} />
        {maintenanceModeActive && (
          <Tag
            tone="warning"
            leftIcon={<Wrench />}
            title="Recovery Mode active — session connected to the debug terminal"
          >
            Recovery
          </Tag>
        )}
      </div>

      {/* Right: action buttons */}
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="ghost"
          size="compact"
          tintColor="var(--content-tertiary)"
          leftIcon={<X />}
          onClick={onClear}
          title="Clear terminal output"
        >
          Clear
        </Button>

        {isConnected || isConnecting ? (
          <Button
            variant="dangerOutline"
            size="compact"
            leftIcon={isConnecting ? <Loader2 className="animate-spin" /> : <Unplug />}
            onClick={onDisconnect}
            disabled={isConnecting}
            title="Disconnect terminal session"
          >
            Disconnect
          </Button>
        ) : (
          <Button
            variant="primary"
            size="compact"
            leftIcon={<PlugZap />}
            onClick={onConnect}
            disabled={!canConnect}
            title="Connect terminal session"
          >
            Connect
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusBadge — visual pill indicating current terminal status
// ---------------------------------------------------------------------------

interface StatusBadgeProps {
  status: TerminalStatus;
}

function StatusBadge({ status }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  return (
    <Tag
      tone={config.tone}
      leftIcon={
        <span
          className={[
            "h-1.5 w-1.5 rounded-full bg-current",
            config.pulse ? "animate-pulse" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        />
      }
      aria-label={`Terminal status: ${config.label}`}
    >
      {config.label}
    </Tag>
  );
}

const STATUS_CONFIG: Record<
  TerminalStatus,
  { label: string; tone: TagTone; pulse?: boolean }
> = {
  idle: { label: "Idle", tone: "neutral" },
  connecting: { label: "Connecting", tone: "warning", pulse: true },
  connected: { label: "Connected", tone: "positive" },
  reconnecting: { label: "Reconnecting", tone: "warning", pulse: true },
  error: { label: "Error", tone: "negative" },
  closed: { label: "Closed", tone: "neutral" },
};
