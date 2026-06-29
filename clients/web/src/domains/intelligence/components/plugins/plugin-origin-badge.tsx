import { Globe, HardDrive } from "lucide-react";
import { createElement } from "react";

import { Tag } from "@vellumai/design-library";

/**
 * Origin badge for plugins, mirroring `SkillOriginBadge`. Renders a
 * design-library `Tag` labeled `External` (with a globe icon) when the plugin
 * comes from a remote host, otherwise `Local` (with a drive icon).
 *
 * `sourceHost` is accepted for parity but does not change the label in v1.
 */
export function PluginOriginBadge({
  external,
  sourceHost: _sourceHost,
  className,
}: {
  external: boolean;
  sourceHost?: string;
  className?: string;
}) {
  const meta = external
    ? { label: "External", icon: Globe }
    : { label: "Local", icon: HardDrive };

  return (
    <Tag tone="neutral" leftIcon={createElement(meta.icon)} className={className}>
      {meta.label}
    </Tag>
  );
}
