import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { useTranslation } from "@/i18n";

import type { McpServerEntry } from "../mcp/mcp-api";
import { summarizeIntegrationConnections } from "../integration-items";
import { IntegrationListRow } from "./integration-list-row";

interface IntegrationRowProps {
  providerKey: string;
  displayName: string;
  description: string | null;
  logoUrl: string | null;
  connections: OAuthConnection[];
  mcpServers?: McpServerEntry[];
  disabled?: boolean;
  onConfigure: () => void;
}

export function IntegrationRow({
  providerKey,
  displayName,
  description,
  logoUrl,
  connections,
  mcpServers = [],
  disabled,
  onConfigure,
}: IntegrationRowProps) {
  const { t } = useTranslation("settings");
  const { connectedCount, needsAttention, configured } =
    summarizeIntegrationConnections(connections, mcpServers);
  return (
    <IntegrationListRow
      icon={
        <IntegrationIcon
          providerKey={providerKey}
          displayName={displayName}
          logoUrl={logoUrl}
          size={32}
        />
      }
      title={displayName}
      subtitle={
        connectedCount > 0
          ? t(
              mcpServers.length > 0
                ? "integrationRow.connectedConnections"
                : "integrationRow.connectedAccounts",
              { count: connectedCount },
            )
          : description
      }
      status={
        connectedCount > 0 ? (
          <Tag tone="positive">{t("integrationRow.connected")}</Tag>
        ) : needsAttention ? (
          <Tag tone="negative">{t("integrationRow.needsAttention")}</Tag>
        ) : undefined
      }
      primaryAction={
        <Button
          variant={configured ? "outlined" : "primary"}
          onClick={onConfigure}
          disabled={disabled}
        >
          {configured
            ? t("integrationRow.configure")
            : t("integrationRow.connect")}
        </Button>
      }
    />
  );
}
