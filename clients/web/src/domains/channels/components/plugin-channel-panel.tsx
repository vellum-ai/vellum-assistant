import { useNavigate } from "react-router";

import { Button } from "@vellumai/design-library/components/button";

import { PluginChannelIcon } from "@/utils/channel-presentation";
import type { PluginChannelSummary } from "@/types/channel-types";

export interface PluginChannelPanelProps {
  channel: PluginChannelSummary;
}

/**
 * Detail panel for a channel a plugin declares.
 *
 * Deliberately thin. The built-in adapters each render a credential form this
 * client knows the shape of; a plugin's does not exist here, and guessing one
 * would be worse than sending the guardian to the plugin, which owns its own
 * setup surface and its own idea of what "connected" means.
 *
 * The description is the plugin manifest's, and a manifest need not carry one,
 * so it is omitted rather than filled with copy this client invented.
 *
 * No connection status for the same reason: nothing in this client can answer
 * it for an arbitrary plugin, and a badge that always reads "Not connected"
 * would be a claim rather than a gap.
 */
export function PluginChannelPanel({ channel }: PluginChannelPanelProps) {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <PluginChannelIcon
        icon={channel.icon}
        className="h-8 w-8 text-[color:var(--content-secondary)]"
      />

      <h3
        className="text-title-medium"
        style={{ color: "var(--content-default)" }}
      >
        {channel.label}
      </h3>

      {channel.description ? (
        <p
          className="max-w-[420px] text-body-medium-default"
          style={{ color: "var(--content-secondary)" }}
        >
          {channel.description}
        </p>
      ) : null}

      <Button
        onClick={() => navigate(`/assistant/plugins/${channel.plugin}`)}
        variant="outlined"
      >
        Open {channel.label} settings
      </Button>
    </div>
  );
}
