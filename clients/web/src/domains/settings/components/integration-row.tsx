import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import type { OAuthConnection } from "@/generated/api/types.gen";
import { useTranslation } from "@/i18n";

import { IntegrationIcon } from "@/components/integrations/integration-icon";

import {
  summarizeIntegrationConnections,
  summarizeOAuthConnections,
  type McpPluginMethod,
} from "../integration-items";
import {
  IntegrationListRow,
  type IntegrationListLayout,
} from "./integration-list-row";

interface IntegrationRowProps {
  providerKey: string;
  displayName: string;
  description: string | null;
  logoUrl: string | null;
  connections: OAuthConnection[];
  mcpMethods?: McpPluginMethod[];
  disabled?: boolean;
  layout?: IntegrationListLayout;
  onConfigure: () => void;
}

export function IntegrationRow({
  providerKey,
  displayName,
  description,
  logoUrl,
  connections,
  mcpMethods = [],
  disabled,
  layout,
  onConfigure,
}: IntegrationRowProps) {
  const { t } = useTranslation("settings");
  const { connectedCount: connectedAccountCount } =
    summarizeOAuthConnections(connections);
  const { needsAttention, configured } = summarizeIntegrationConnections(
    connections,
    mcpMethods,
  );

  return (
    <IntegrationListRow
      layout={layout}
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
        connectedAccountCount > 0
          ? t("integrationRow.connectedAccounts", {
              count: connectedAccountCount,
            })
          : description
      }
      status={
        needsAttention ? (
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
