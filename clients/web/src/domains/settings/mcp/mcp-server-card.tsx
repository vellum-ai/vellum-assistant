import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Power,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useState } from "react";

import type { McpServerEntry, McpToolsSummaryServer } from "./mcp-api";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { ListRow } from "@vellumai/design-library/components/list-row";
import { Toggle } from "@vellumai/design-library/components/toggle";

const STATUS_CONFIG: Record<string, { icon: typeof CheckCircle2; label: string; className: string }> = {
  connected: { icon: CheckCircle2, label: "Connected", className: "text-[var(--system-positive-strong)]" },
  "needs-auth": { icon: KeyRound, label: "Needs Auth", className: "text-[var(--system-warning-strong)]" },
  disabled: { icon: Power, label: "Disabled", className: "text-[var(--content-tertiary)]" },
};

const DEFAULT_STATUS = { icon: AlertCircle, label: "Error", className: "text-[var(--system-negative-strong)]" };

interface McpServerCardProps {
  server: McpServerEntry;
  toolsSummary: McpToolsSummaryServer | undefined;
  onToggleEnabled: (serverId: string, enabled: boolean) => void;
  onRemove: (serverId: string) => void;
  onConfigure: (serverId: string) => void;
  onAuthenticate: (serverId: string) => void;
  onRevokeOAuth: (serverId: string) => void;
  isUpdating: boolean;
  isAuthenticating: boolean;
  isRevoking: boolean;
}

export function McpServerCard({
  server,
  toolsSummary,
  onToggleEnabled,
  onRemove,
  onConfigure,
  onAuthenticate,
  onRevokeOAuth,
  isUpdating,
  isAuthenticating,
  isRevoking,
}: McpServerCardProps) {
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const statusInfo = STATUS_CONFIG[server.status] ?? DEFAULT_STATUS;
  const StatusIcon = statusInfo.icon;

  const handleToggle = useCallback(
    (next: boolean) => onToggleEnabled(server.id, next),
    [onToggleEnabled, server.id],
  );

  const handleRemove = useCallback(
    () => onRemove(server.id),
    [onRemove, server.id],
  );

  const handleConfigure = useCallback(
    () => onConfigure(server.id),
    [onConfigure, server.id],
  );

  const handleAuthenticate = useCallback(
    () => onAuthenticate(server.id),
    [onAuthenticate, server.id],
  );

  const handleRevokeOAuth = useCallback(
    () => onRevokeOAuth(server.id),
    [onRevokeOAuth, server.id],
  );

  const toggleToolsExpanded = useCallback(
    () => setToolsExpanded((prev) => !prev),
    [],
  );

  return (
    <Card.Root>
      <Card.Body>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-body-medium-default text-[var(--content-default)]">
                  {server.id}
                </span>
                <span className={`flex items-center gap-1 text-label-medium-default ${statusInfo.className}`}>
                  <StatusIcon className="h-3.5 w-3.5" />
                  {statusInfo.label}
                </span>
                {server.hasOAuth ? (
                  <span className="rounded-full bg-[var(--surface-lift)] px-2 py-0.5 text-label-small-default text-[var(--content-secondary)]">
                    OAuth
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
                <span>{server.transport.type}</span>
                {toolsSummary ? (
                  <>
                    <span aria-hidden="true">&middot;</span>
                    <span>
                      {toolsSummary.toolCount} {toolsSummary.toolCount === 1 ? "tool" : "tools"}
                    </span>
                    <span aria-hidden="true">&middot;</span>
                    <span>~{toolsSummary.estimatedTokens.toLocaleString()} tokens</span>
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {isUpdating || isAuthenticating ? (
              <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
            ) : null}
            {server.status === "needs-auth" && server.transport.type !== "stdio" && !server.hasOAuth ? (
              <Button
                variant="ghost"
                size="compact"
                leftIcon={<LogIn />}
                onClick={handleAuthenticate}
                disabled={isAuthenticating}
              >
                {isAuthenticating ? "Authenticating..." : "Authenticate"}
              </Button>
            ) : null}
            {server.hasOAuth ? (
              <>
                <Button
                  variant="ghost"
                  size="compact"
                  leftIcon={<RefreshCw />}
                  onClick={handleAuthenticate}
                  disabled={isAuthenticating}
                  tooltip="Re-authenticate OAuth"
                >
                  Re-auth
                </Button>
                <Button
                  variant="dangerGhost"
                  size="compact"
                  leftIcon={<LogOut />}
                  onClick={handleRevokeOAuth}
                  disabled={isRevoking}
                  tooltip="Revoke OAuth credentials"
                >
                  {isRevoking ? "Revoking..." : "Revoke"}
                </Button>
              </>
            ) : null}
            <Toggle
              checked={server.enabled}
              onChange={handleToggle}
              disabled={isUpdating}
              aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.id}`}
            />
            <Button
              variant="ghost"
              size="compact"
              onClick={handleConfigure}
              tooltip="Configure"
            >
              Configure
            </Button>
            <Button
              variant="dangerGhost"
              size="compact"
              iconOnly={<Trash2 />}
              onClick={handleRemove}
              tooltip="Remove server"
              aria-label={`Remove ${server.id}`}
            />
          </div>
        </div>

        {toolsSummary && toolsSummary.tools.length > 0 ? (
          <div className="mt-3 border-t border-[var(--border-base)] pt-2">
            <button
              type="button"
              onClick={toggleToolsExpanded}
              className="flex w-full cursor-pointer items-center gap-1 text-body-small-default text-[var(--content-secondary)] hover:text-[var(--content-default)]"
            >
              {toolsExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              {toolsSummary.toolCount} registered {toolsSummary.toolCount === 1 ? "tool" : "tools"}
            </button>

            {toolsExpanded ? (
              <div className="mt-2 max-h-60 overflow-y-auto">
                {toolsSummary.tools.map((tool) => (
                  <ListRow
                    key={tool.name}
                    title={tool.name}
                    subtitle={tool.description || undefined}
                    trailing={
                      <span className="whitespace-nowrap text-body-small-default text-[var(--content-secondary)]">
                        ~{tool.estimatedTokens.toLocaleString()} tok
                      </span>
                    }
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </Card.Body>
    </Card.Root>
  );
}
