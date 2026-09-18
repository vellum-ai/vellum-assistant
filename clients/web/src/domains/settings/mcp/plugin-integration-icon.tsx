import { PluginIcon } from "@/components/plugins/plugin-icon";
import { usePluginIconSrc } from "@/hooks/use-plugin-icon-src";

import type { McpPluginDefinition } from "../integration-items";

import { pluginLogoUrl } from "./plugin-logo";

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
      iconUrl={pluginLogoUrl(definition) ?? undefined}
      size="md"
    />
  );
}
