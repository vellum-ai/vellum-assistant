import { PluginIcon } from "@/components/plugins/plugin-icon";
import { usePluginIconSrc } from "@/hooks/use-plugin-icon-src";
import { publicAsset } from "@/utils/public-asset";

import type { McpPluginDefinition } from "../integration-items";

export function PluginIntegrationIcon({
  assistantId,
  definition,
}: {
  assistantId: string;
  definition: McpPluginDefinition;
}) {
  const iconSrc = usePluginIconSrc(
    assistantId,
    definition.pluginName,
    definition.installed?.hasIcon,
    definition.installed?.iconVersion,
  );

  return (
    <PluginIcon
      external
      icon={definition.installed?.icon}
      iconSrc={iconSrc}
      iconUrl={publicAsset(`/images/integrations/${definition.logo}`)}
      size="md"
    />
  );
}
