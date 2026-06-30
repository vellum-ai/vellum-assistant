/**
 * Small pill flagging that an installed plugin is behind the marketplace
 * pin. Shared by the plugins list row and the plugin detail header so the
 * "update available" affordance reads identically on both surfaces.
 */
import { ArrowUpCircle } from "lucide-react";
import { createElement } from "react";

import { Tag } from "@vellumai/design-library";

export function UpdateAvailableBadge() {
  return (
    <Tag tone="warning" leftIcon={createElement(ArrowUpCircle)} className="shrink-0">
      Update available
    </Tag>
  );
}
