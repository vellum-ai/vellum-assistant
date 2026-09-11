import { Loader2, MoreHorizontal, Settings, Trash2 } from "lucide-react";

import { ActionMenu } from "@vellumai/design-library/components/action-menu";
import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import { useTranslation } from "@/i18n";

import { IntegrationListRow } from "../components/integration-list-row";
import type { McpServerEntry } from "./mcp-api";
import { McpIntegrationIcon } from "./mcp-integration-icon";
import {
  integrationHostname,
  mcpLifecycleState,
  supportsMcpAction,
} from "../integration-items";

interface McpServerCardProps {
  server: McpServerEntry;
  displayName?: string;
  providerKey?: string;
  onRemove: (serverId: string) => void;
  onConfigure: (serverId: string) => void;
  onAuthenticate: (serverId: string) => void;
  isAuthenticating: boolean;
  connectDisabled?: boolean;
  onManagePlugin?: (pluginName?: string) => void;
}

export function McpServerCard({
  server,
  displayName,
  providerKey,
  onRemove,
  onConfigure,
  onAuthenticate,
  isAuthenticating,
  connectDisabled = false,
  onManagePlugin,
}: McpServerCardProps) {
  const { t } = useTranslation("settings");
  const state = isAuthenticating ? "connecting" : mcpLifecycleState(server);
  const pluginOwned = server.source === "plugin";
  const needsAuth =
    state === "needs-auth" &&
    !server.hasStaticAuth &&
    supportsMcpAction(server, "authenticate");
  const isConnected = state === "connected";
  const actionLabel = pluginOwned
    ? t("mcpServerCard.managePlugin")
    : isAuthenticating
      ? t("mcpServerCard.connecting")
      : needsAuth
        ? server.hasOAuth
          ? t("mcpServerCard.reconnect")
          : t("mcpServerCard.finishConnecting")
        : t("mcpServerCard.configure");
  const statusLabel = isConnected
    ? t("mcpServerCard.statusConnected")
    : state === "connecting"
      ? t("mcpServerCard.statusConnecting")
      : state === "declared"
        ? t("mcpServerCard.statusDeclared")
        : state === "not-started"
          ? t("mcpServerCard.statusNotStarted")
          : t("mcpServerCard.statusNeedsAttention");
  const statusTone = isConnected
    ? "positive"
    : state === "connecting" || state === "declared" || state === "not-started"
      ? "neutral"
      : "negative";
  const showDetailsAction = needsAuth || pluginOwned || isAuthenticating;
  const canRemove = supportsMcpAction(server, "remove");

  return (
    <IntegrationListRow
      icon={
        <McpIntegrationIcon
          providerKey={providerKey}
          endpointUrl={server.transport.url}
        />
      }
      title={displayName ?? server.id}
      subtitle={pluginOwned ? server.pluginName : integrationHostname(server)}
      status={<Tag tone={statusTone}>{statusLabel}</Tag>}
      primaryAction={
        <Button
          variant={needsAuth ? "primary" : "outlined"}
          leftIcon={
            isAuthenticating ? <Loader2 className="animate-spin" /> : undefined
          }
          onClick={() =>
            pluginOwned
              ? onManagePlugin?.(server.pluginName)
              : needsAuth
                ? onAuthenticate(server.id)
                : onConfigure(server.id)
          }
          disabled={
            !pluginOwned && (isAuthenticating || (needsAuth && connectDisabled))
          }
        >
          {actionLabel}
        </Button>
      }
      actionMenu={
        showDetailsAction || canRemove ? (
          <ActionMenu.Root>
            <ActionMenu.Trigger asChild>
              <Button
                variant="ghost"
                iconOnly={<MoreHorizontal />}
                className="min-w-11"
                aria-label={t("mcpServerCard.moreActions", {
                  serverId: displayName ?? server.id,
                })}
              />
            </ActionMenu.Trigger>
            <ActionMenu.Content
              title={displayName ?? server.id}
              showTitle
              closeLabel={t("mcpServerCard.actionsSheetClose")}
              align="end"
            >
              {showDetailsAction ? (
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
              {canRemove ? (
                <ActionMenu.Item
                  icon={Trash2}
                  label={
                    server.catalog
                      ? t("mcpServerCard.disconnect")
                      : t("mcpServerCard.removeServer")
                  }
                  tone="destructive"
                  onSelect={() => onRemove(server.id)}
                />
              ) : null}
            </ActionMenu.Content>
          </ActionMenu.Root>
        ) : undefined
      }
    />
  );
}
