import { Loader2, PlugZap, Terminal, Unplug, Wrench, X } from "lucide-react";

import { useTranslation } from "@/i18n";
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
  const { t } = useTranslation("terminal");
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
          {t("terminalToolbar.heading")}
        </span>
        <StatusBadge status={status} />
        {maintenanceModeActive && (
          <Tag
            tone="warning"
            leftIcon={<Wrench />}
            title={t("terminalToolbar.recoveryTitle")}
          >
            {t("terminalToolbar.recoveryTag")}
          </Tag>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="compact"
          leftIcon={<X />}
          onClick={onClear}
          title={t("terminalToolbar.clearTitle")}
        >
          {t("terminalToolbar.clear")}
        </Button>

        {isConnected || isConnecting ? (
          <Button
            variant="danger"
            size="compact"
            leftIcon={
              isConnecting ? <Loader2 className="animate-spin" /> : <Unplug />
            }
            onClick={onDisconnect}
            disabled={isConnecting}
            title={t("terminalToolbar.disconnectTitle")}
          >
            {t("terminalToolbar.disconnect")}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="compact"
            leftIcon={<PlugZap />}
            onClick={onConnect}
            disabled={!canConnect}
            title={t("terminalToolbar.connectTitle")}
          >
            {t("terminalToolbar.connect")}
          </Button>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: TerminalStatus }) {
  const { t } = useTranslation("terminal");
  const config = STATUS_CONFIG[status];
  const label = t(config.labelKey);
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
      aria-label={t("terminalToolbar.statusAria", { status: label })}
    >
      {label}
    </Tag>
  );
}

/**
 * Tone and pulse per status. The label is a catalog key rather than copy: a
 * module-scope table cannot call `useTranslation()`, so a plain string here
 * would render English whatever the active locale is.
 */
const STATUS_CONFIG: Record<
  TerminalStatus,
  {
    labelKey: `terminalStatus.${TerminalStatus}`;
    tone: TagTone;
    pulse?: boolean;
  }
> = {
  idle: { labelKey: "terminalStatus.idle", tone: "neutral" },
  connecting: {
    labelKey: "terminalStatus.connecting",
    tone: "warning",
    pulse: true,
  },
  connected: { labelKey: "terminalStatus.connected", tone: "positive" },
  reconnecting: {
    labelKey: "terminalStatus.reconnecting",
    tone: "warning",
    pulse: true,
  },
  error: { labelKey: "terminalStatus.error", tone: "negative" },
  closed: { labelKey: "terminalStatus.closed", tone: "neutral" },
};
