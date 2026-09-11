import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { useTranslation } from "@/i18n";

import { summarizeOAuthConnections } from "../integration-items";
import { IntegrationListRow } from "./integration-list-row";

interface IntegrationRowProps {
  providerKey: string;
  displayName: string;
  description: string | null;
  logoUrl: string | null;
  connections: OAuthConnection[];
  disabled?: boolean;
  onConfigure: () => void;
}

export function IntegrationRow({
  providerKey,
  displayName,
  description,
  logoUrl,
  connections,
  disabled,
  onConfigure,
}: IntegrationRowProps) {
  const { t } = useTranslation("settings");
  const { connectedCount, needsAttention } = summarizeOAuthConnections(
    connections,
  );
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
          ? t("integrationRow.connectedAccounts", { count: connectedCount })
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
          variant={connections.length > 0 ? "outlined" : "primary"}
          onClick={onConfigure}
          disabled={disabled}
        >
          {connections.length > 0
            ? t("integrationRow.configure")
            : t("integrationRow.connect")}
        </Button>
      }
    />
  );
}
