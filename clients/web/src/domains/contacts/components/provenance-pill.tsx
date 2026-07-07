import { Link } from "react-router";

import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import type { SetupChannelId } from "@/domains/contacts/types";
import { getChannelLabel } from "@/utils/channel-presentation";
import { routes } from "@/utils/routes";

/**
 * Which layer of the permission cascade sets a channel's effective admission
 * floor. `global-default` means no channel-level floor is stored; the
 * built-in default applies. `channel-default` means the floor was explicitly
 * set for that channel on the Channels tab.
 */
export type CascadeProvenance =
  | { source: "global-default" }
  | { source: "channel-default"; channel: SetupChannelId };

export interface ProvenancePillProps {
  provenance: CascadeProvenance;
}

/**
 * Neutral pill naming the cascade layer a contact channel's effective access
 * comes from — "Global default", or "Default from Channels → Slack" with the
 * channel part linking to that channel's sub-tab on the Channels page.
 */
export function ProvenancePill({ provenance }: ProvenancePillProps) {
  if (provenance.source === "global-default") {
    return <Tag>Global default</Tag>;
  }
  return (
    <Tag>
      Default from
      <Button asChild variant="link" size="compact" className="h-auto px-0">
        <Link to={`${routes.channels}?setup=${provenance.channel}`}>
          Channels → {getChannelLabel(provenance.channel)}
        </Link>
      </Button>
    </Tag>
  );
}
