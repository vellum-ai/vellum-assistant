import { Globe, HardDrive } from "lucide-react";
import { createElement } from "react";

import { useTranslation } from "@/i18n";
import { Tag } from "@vellumai/design-library";

/**
 * Origin badge for plugins, mirroring `SkillOriginBadge`. Renders a
 * design-library `Tag` labeled `External` (with a globe icon) when the plugin
 * comes from a remote host, otherwise `Local` (with a drive icon).
 */
export function PluginOriginBadge({
  external,
  className,
}: {
  external: boolean;
  className?: string;
}) {
  const { t } = useTranslation("intelligence");
  const meta = external
    ? { label: t("pluginOriginBadge.external"), icon: Globe }
    : { label: t("pluginOriginBadge.local"), icon: HardDrive };

  return (
    <Tag
      tone="neutral"
      leftIcon={createElement(meta.icon)}
      className={className}
    >
      {meta.label}
    </Tag>
  );
}
