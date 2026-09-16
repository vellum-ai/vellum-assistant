import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import { useTranslation } from "@/i18n";

import { IntegrationListRow } from "../components/integration-list-row";
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
      layout={summary.configured ? "row" : "tile"}
      icon={
        <PluginIntegrationIcon
          assistantId={assistantId}
          definition={method.definition}
        />
      }
      title={method.definition.displayName}
      subtitle={method.definition.description}
      status={
        summary.configured ? (
          <Tag tone={summary.needsAttention ? "negative" : "positive"}>
            {summary.needsAttention
              ? t("integrationRow.needsAttention")
              : t("integrationRow.connected")}
          </Tag>
        ) : undefined
      }
      primaryAction={
        <Button
          variant={summary.configured ? "outlined" : "primary"}
          disabled={disabled}
          onClick={onOpen}
        >
          {summary.configured
            ? t("integrationRow.configure")
            : method.definition.setup.mode === "manual"
              ? t("pluginIntegration.setUp")
              : t("integrationRow.connect")}
        </Button>
      }
    />
  );
}
