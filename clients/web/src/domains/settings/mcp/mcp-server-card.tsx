import { MoreHorizontal, Settings, Trash2 } from "lucide-react";

import { ActionMenu } from "@vellumai/design-library/components/action-menu";
import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import { useTranslation } from "@/i18n";

import {
  INTEGRATION_ACTION_SIZING,
  IntegrationListRow,
} from "../components/integration-list-row";
import { integrationHostname } from "../integration-items";
import type { McpServerEntry } from "./mcp-api";
import { McpIntegrationIcon } from "./mcp-integration-icon";

interface McpServerCardProps {
  server: McpServerEntry;
  onRemove: (serverId: string) => void;
  onConfigure: (serverId: string) => void;
  onAuthenticate: (serverId: string) => void;
  onManagePlugin: (pluginName?: string) => void;
  isAuthenticating: boolean;
  connectDisabled?: boolean;
}

export function McpServerCard({
  server,
  onRemove,
  onConfigure,
  onAuthenticate,
  onManagePlugin,
  isAuthenticating,
  connectDisabled = false,
}: McpServerCardProps) {
  const { t } = useTranslation("settings");
  const pluginOwned = server.source === "plugin";
  const needsAuth =
    !pluginOwned &&
    server.status === "needs-auth" &&
    server.transport.type !== "stdio";
  // Configure is the resting action, so it takes the same outlined icon slot
  // the rest of the list uses. The exceptional states keep their verb: a
  // reconnect or a plugin hand-off is not something to guess from a glyph.
  const configureOnly = !pluginOwned && !isAuthenticating && !needsAuth;
  const actionLabel = pluginOwned
    ? t("mcpServerCard.managePlugin")
    : isAuthenticating
      ? t("mcpServerCard.connecting")
      : server.hasOAuth
        ? t("mcpServerCard.reconnect")
        : t("mcpServerCard.finishConnecting");

  return (
    <IntegrationListRow
      icon={<McpIntegrationIcon />}
      title={server.id}
      subtitle={pluginOwned ? server.pluginName : integrationHostname(server)}
      status={
        server.status === "connected" ? undefined : (
          <Tag tone="negative">{t("mcpServerCard.statusNeedsAttention")}</Tag>
        )
      }
      primaryAction={
        configureOnly ? (
          <Button
            variant="outlined"
            className={INTEGRATION_ACTION_SIZING}
            iconOnly={<Settings />}
            aria-label={t("mcpServerCard.configureLabel", {
              serverId: server.id,
            })}
            onClick={() => onConfigure(server.id)}
          />
        ) : (
          <Button
            variant={needsAuth ? "primary" : "outlined"}
            loading={isAuthenticating}
            onClick={() => {
              if (pluginOwned) {
                onManagePlugin(server.pluginName);
              } else if (needsAuth) {
                onAuthenticate(server.id);
              }
            }}
            disabled={isAuthenticating || (needsAuth && connectDisabled)}
          >
            {actionLabel}
          </Button>
        )
      }
      actionMenu={
        <ActionMenu.Root>
          <ActionMenu.Trigger asChild>
            <Button
              variant="ghost"
              iconOnly={<MoreHorizontal />}
              className={INTEGRATION_ACTION_SIZING}
              aria-label={t("mcpServerCard.moreActions", {
                serverId: server.id,
              })}
            />
          </ActionMenu.Trigger>
          <ActionMenu.Content
            title={server.id}
            showTitle
            closeLabel={t("mcpServerCard.actionsSheetClose")}
            align="end"
          >
            {needsAuth || pluginOwned ? (
              <ActionMenu.Item
                icon={Settings}
                label={
                  pluginOwned
                    ? t("mcpServerCard.viewDetails")
                    : t("mcpServerCard.configure")
                }
                onSelect={() => onConfigure(server.id)}
              />
            ) : null}
            {!pluginOwned ? (
              <ActionMenu.Item
                icon={Trash2}
                label={t("mcpServerCard.removeServer")}
                tone="destructive"
                onSelect={() => onRemove(server.id)}
              />
            ) : null}
          </ActionMenu.Content>
        </ActionMenu.Root>
      }
    />
  );
}
