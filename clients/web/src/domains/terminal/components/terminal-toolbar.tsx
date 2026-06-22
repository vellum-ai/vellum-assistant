import { Loader2, PlugZap, Terminal, Unplug, Wrench, X } from "lucide-react";

import type { TerminalStatus } from "@/domains/terminal/types";
import { Button } from "@vellumai/design-library/components/button";
import { Tag, type TagTone } from "@vellumai/design-library/components/tag";

interface TerminalToolbarProps {
  status: TerminalStatus;
  onConnect: () => void;
  onDisconnect: () => void;
  onClear: () => void;
  className?: string;
  maintenanceModeActive?: boolean;
}

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
  const canConnect =
    status === "idle" || status === "closed" || status === "error";

  return (
    <div
      className={[
        "flex items-center justify-between gap-3 border-b px-3 py-1.5",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        background: "var(--surface-lift)",
        borderColor: "var(--border-base)",
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Terminal
          className="h-4 w-4 shrink-0"
          style={{ color: "var(--content-tertiary)" }}
        />
        <span
          className="truncate text-body-medium-default"
          style={{ color: "var(--content-secondary)" }}
        >
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

      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="compact"
          leftIcon={<X />}
          onClick={onClear}
          title="Clear terminal output"
        >
          Clear
        </Button>

        {isConnected || isConnecting ? (
          <Button
            variant="danger"
            size="compact"
            leftIcon={
              isConnecting ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Unplug />
              )
            }
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

function StatusBadge({ status }: { status: TerminalStatus }) {
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
