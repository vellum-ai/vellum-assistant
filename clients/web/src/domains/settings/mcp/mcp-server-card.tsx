import { Loader2, MoreHorizontal, Settings, Trash2 } from "lucide-react";

import { ActionMenu } from "@vellumai/design-library/components/action-menu";
import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import { useTranslation } from "@/i18n";

import { IntegrationListRow } from "../components/integration-list-row";
import type { McpServerEntry } from "./mcp-api";
import { McpIntegrationIcon } from "./mcp-integration-icon";

interface McpServerCardProps {
  server: McpServerEntry;
  onRemove: (serverId: string) => void;
  onConfigure: (serverId: string) => void;
  onAuthenticate: (serverId: string) => void;
  isAuthenticating: boolean;
}

export function McpServerCard({
  server,
  onRemove,
  onConfigure,
  onAuthenticate,
  isAuthenticating,
}: McpServerCardProps) {
  const { t } = useTranslation("settings");
  const needsAuth =
    server.status === "needs-auth" && server.transport.type !== "stdio";
  const isConnected = server.status === "connected";
  const actionLabel = isAuthenticating
    ? t("mcpServerCard.connecting")
    : needsAuth
      ? server.hasOAuth
        ? t("mcpServerCard.reconnect")
        : t("mcpServerCard.finishConnecting")
      : t("mcpServerCard.configure");

  return (
    <IntegrationListRow
      icon={<McpIntegrationIcon />}
      title={server.id}
      status={
        <Tag tone={isConnected ? "positive" : "negative"}>
          {isConnected
            ? t("mcpServerCard.statusConnected")
            : t("mcpServerCard.statusNeedsAttention")}
        </Tag>
      }
      primaryAction={
        <Button
          variant={needsAuth ? "primary" : "outlined"}
          leftIcon={isAuthenticating ? <Loader2 className="animate-spin" /> : undefined}
          onClick={() =>
            needsAuth ? onAuthenticate(server.id) : onConfigure(server.id)
          }
          disabled={isAuthenticating}
        >
          {actionLabel}
        </Button>
      }
      actionMenu={
        <ActionMenu.Root>
          <ActionMenu.Trigger asChild>
            <Button
              variant="ghost"
              iconOnly={<MoreHorizontal />}
              className="min-w-11"
              aria-label={t("mcpServerCard.moreActions", { serverId: server.id })}
            />
          </ActionMenu.Trigger>
          <ActionMenu.Content
            title={server.id}
            showTitle
            closeLabel={t("mcpServerCard.actionsSheetClose")}
            align="end"
          >
            {needsAuth ? (
              <ActionMenu.Item
                icon={Settings}
                label={t("mcpServerCard.configure")}
                onSelect={() => onConfigure(server.id)}
              />
            ) : null}
            <ActionMenu.Item
              icon={Trash2}
              label={t("mcpServerCard.removeServer")}
              tone="destructive"
              onSelect={() => onRemove(server.id)}
            />
          </ActionMenu.Content>
        </ActionMenu.Root>
      }
    />
  );
}
