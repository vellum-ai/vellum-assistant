import { Settings } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import { useTranslation } from "@/i18n";

import {
  INTEGRATION_ACTION_SIZING,
  IntegrationListRow,
} from "../components/integration-list-row";
import {
  summarizeIntegrationConnections,
  type McpPluginMethod,
} from "../integration-items";
import { PluginIntegrationIcon } from "./plugin-integration-icon";

export function PluginIntegrationRow({
  assistantId,
  method,
  disabled,
  onOpen,
}: {
  assistantId: string;
  method: McpPluginMethod;
  disabled?: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation("settings");
  const summary = summarizeIntegrationConnections([], [method]);

  return (
    <IntegrationListRow
      icon={
        <PluginIntegrationIcon
          assistantId={assistantId}
          definition={method.definition}
        />
      }
      title={method.definition.displayName}
      subtitle={method.definition.description}
      status={
        summary.needsAttention ? (
          <Tag tone="negative">{t("integrationRow.needsAttention")}</Tag>
        ) : undefined
      }
      primaryAction={
        <Button
          variant="outlined"
          className={INTEGRATION_ACTION_SIZING}
          iconOnly={<Settings />}
          aria-label={t("integrationRow.configureLabel", {
            name: method.definition.displayName,
          })}
          disabled={disabled}
          onClick={onOpen}
        />
      }
    />
  );
}
