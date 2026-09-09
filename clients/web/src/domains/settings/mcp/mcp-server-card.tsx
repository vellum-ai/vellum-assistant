import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Lock,
  LogOut,
  MoreHorizontal,
  Settings,
  Trash2,
} from "lucide-react";
import { useCallback, useState } from "react";

import type { McpServerEntry, McpToolsSummaryServer } from "./mcp-api";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { ListRow } from "@vellumai/design-library/components/list-row";
import { ActionMenu } from "@vellumai/design-library/components/action-menu";
import { Tag, type TagTone } from "@vellumai/design-library/components/tag";

import { useTranslation } from "@/i18n";

import { McpActionButton } from "./mcp-action-button";

type SettingsTranslate = ReturnType<
  typeof useTranslation<"settings">
>["t"];

/**
 * Tone per connection status. A status is a chip beside the server's name
 * rather than an icon and a coloured word: same information, one shape.
 *
 * `needs-auth` wears the negative tone per the design, which reads it as a
 * thing that is not working rather than a caution. An unrecognised status is
 * an error, and gets the same tone with its own label.
 */
const STATUS_TONES: Record<string, TagTone> = {
  connected: "positive",
  "needs-auth": "negative",
};

const DEFAULT_STATUS_TONE: TagTone = "negative";

function statusLabel(status: string, t: SettingsTranslate): string {
  switch (status) {
    case "connected":
      return t("mcpServerCard.statusConnected");
    case "needs-auth":
      return t("mcpServerCard.statusNeedsAuth");
    default:
      return t("mcpServerCard.statusError");
  }
}

interface McpServerCardProps {
  server: McpServerEntry;
  toolsSummary: McpToolsSummaryServer | undefined;
  onRemove: (serverId: string) => void;
  onConfigure: (serverId: string) => void;
  onAuthenticate: (serverId: string) => void;
  onRevokeOAuth: (serverId: string) => void;
  isAuthenticating: boolean;
  isRevoking: boolean;
}

export function McpServerCard({
  server,
  toolsSummary,
  onRemove,
  onConfigure,
  onAuthenticate,
  onRevokeOAuth,
  isAuthenticating,
  isRevoking,
}: McpServerCardProps) {
  const { t } = useTranslation("settings");
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const statusTone = STATUS_TONES[server.status] ?? DEFAULT_STATUS_TONE;
  // A stored OAuth grant is not the same as a working one: the list route
  // reports `hasOAuth` from the tokens on disk, while the health check reports
  // whether they still authenticate. Expired or server-side-revoked tokens
  // arrive as both at once, so the status is what decides, and the grant only
  // decides which of the two flows the row offers.
  const hasOAuthGrant = server.hasOAuth;
  const isAuthenticated = hasOAuthGrant && server.status !== "needs-auth";
  // A static bearer or api-key is configuration the user typed, never a flow
  // this row can start or finish, and `stdio` runs locally with nothing to
  // sign in to.
  const needsAuth =
    server.status === "needs-auth" && server.transport.type !== "stdio";

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
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-1">
              <span className="truncate text-body-large-default text-[var(--content-default)]">
                {server.id}
              </span>
              <Tag tone={statusTone}>{statusLabel(server.status, t)}</Tag>
              {isAuthenticated ? (
                <Tag tone="positive">
                  {t("mcpServerCard.authenticatedBadge")}
                </Tag>
              ) : null}
            </div>
            <div className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
              <span>{server.transport.type}</span>
              {toolsSummary ? (
                <>
                  <span aria-hidden="true">&middot;</span>
                  <span>
                    {t("mcpServerCard.toolCount", {
                      count: toolsSummary.toolCount,
                    })}
                  </span>
                  <span aria-hidden="true">&middot;</span>
                  <span>
                    {t("mcpServerCard.estimatedTokens", {
                      count: toolsSummary.estimatedTokens.toLocaleString(),
                    })}
                  </span>
                </>
              ) : null}
            </div>
          </div>

          {/* Actions. The label on the first one is what gives way when the
              window is too narrow for it; the icon and the two beside it are
              the same control either way. */}
          <div className="flex shrink-0 items-center gap-2">
            {needsAuth ? (
              <McpActionButton
                variant="primary"
                icon={
                  isAuthenticating ? <Loader2 className="animate-spin" /> : <Lock />
                }
                label={
                  isAuthenticating
                    ? t("mcpServerCard.authenticating")
                    : hasOAuthGrant
                      ? t("mcpServerCard.reAuth")
                      : t("mcpServerCard.authenticate")
                }
                onClick={handleAuthenticate}
                disabled={isAuthenticating}
              />
            ) : null}

            {hasOAuthGrant ? (
              <Button
                variant="dangerOutline"
                iconOnly={isRevoking ? <Loader2 className="animate-spin" /> : <LogOut />}
                onClick={handleRevokeOAuth}
                disabled={isRevoking}
                tooltip={t("mcpServerCard.revokeOAuthTooltip")}
                aria-label={t("mcpServerCard.revoke")}
              />
            ) : null}

            {/* One menu, two surfaces: an anchored dropdown under a pointer,
                a bottom sheet under a thumb. `ActionMenu` owns that choice, so
                the commands are declared once and cannot drift apart. */}
            <ActionMenu.Root>
              <ActionMenu.Trigger asChild>
                <Button
                  variant="outlined"
                  iconOnly={<MoreHorizontal />}
                  aria-label={t("mcpServerCard.moreActions", {
                    serverId: server.id,
                  })}
                />
              </ActionMenu.Trigger>
              <ActionMenu.Content
                title={t("mcpServerCard.moreActions", { serverId: server.id })}
                showTitle
                closeLabel={t("mcpServerCard.actionsSheetClose")}
                align="end"
              >
                <ActionMenu.Item
                  icon={Settings}
                  label={t("mcpServerCard.configure")}
                  onSelect={handleConfigure}
                />
                <ActionMenu.Item
                  icon={Trash2}
                  label={t("mcpServerCard.removeServer")}
                  tone="destructive"
                  onSelect={handleRemove}
                />
              </ActionMenu.Content>
            </ActionMenu.Root>
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
              {t("mcpServerCard.registeredTools", {
                count: toolsSummary.toolCount,
              })}
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
                        {t("mcpServerCard.toolTokensAbbrev", {
                          count: tool.estimatedTokens.toLocaleString(),
                        })}
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
