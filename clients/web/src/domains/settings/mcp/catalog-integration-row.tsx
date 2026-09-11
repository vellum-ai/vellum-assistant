import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import { useTranslation } from "@/i18n";

import { IntegrationListRow } from "../components/integration-list-row";
import {
  summarizeIntegrationConnections,
  type CatalogMethod,
} from "../integration-items";
import { McpIntegrationIcon } from "./mcp-integration-icon";
import { McpServerCard } from "./mcp-server-card";
import type { useMcpConnections } from "./use-mcp-connections";

export function CatalogIntegrationRow({
  method,
  connections,
  onOpen,
  onConnect,
}: {
  method: CatalogMethod;
  connections: ReturnType<typeof useMcpConnections>;
  onOpen: () => void;
  onConnect: () => void;
}) {
  const { t } = useTranslation("settings");
  const { definition, servers } = method;
  const busy = connections.auth.isBusy;
  if (servers.length === 1) {
    const server = servers[0]!;
    return (
      <McpServerCard
        server={server}
        displayName={definition.displayName}
        providerKey={definition.icon}
        onConfigure={connections.setConfigureServerId}
        onAuthenticate={connections.connectServer}
        onRemove={connections.setRemoveServerId}
        isAuthenticating={
          busy && connections.auth.attempt?.serverId === server.id
        }
        connectDisabled={busy}
      />
    );
  }
  const connected =
    summarizeIntegrationConnections([], servers).connectedCount > 0;
  return (
    <IntegrationListRow
      icon={
        <McpIntegrationIcon
          providerKey={definition.icon}
          endpointUrl={
            definition.documents.mcp?.mcpServers?.[definition.serverKey]?.url
          }
        />
      }
      title={definition.displayName}
      subtitle={definition.description}
      status={
        servers.length > 0 ? (
          <Tag tone={connected ? "positive" : "negative"}>
            {connected
              ? t("mcpServerCard.statusConnected")
              : t("mcpServerCard.statusNeedsAttention")}
          </Tag>
        ) : undefined
      }
      primaryAction={
        <Button
          variant={servers.length > 0 ? "outlined" : "primary"}
          disabled={
            servers.length === 0 &&
            (busy || !connections.catalog.data?.supportsConnect)
          }
          onClick={servers.length > 0 ? onOpen : onConnect}
        >
          {servers.length > 0
            ? t("mcpServerCard.configure")
            : definition.setup.mode === "manual"
              ? t("mcpCatalog.setUp")
              : t("integrationRow.connect")}
        </Button>
      }
    />
  );
}
