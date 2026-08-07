import { useNavigate } from "react-router";

import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import { useChannelIngress } from "@/domains/channels/hooks/use-channel-ingress";
import { PluginChannelIcon } from "@/utils/channel-presentation";
import type { PluginChannelSummary } from "@/types/channel-types";

export interface PluginChannelPanelProps {
  channel: PluginChannelSummary;
  assistantId: string;
}

/**
 * Detail panel for a channel a plugin brings.
 *
 * Two things belong here and nothing else. The ingress approval, because a
 * plugin channel's routes are refused until a guardian grants them and this is
 * where someone would look for that. And a way through to the plugin, because
 * the built-in adapters each render a credential form this client knows the
 * shape of and a plugin's does not exist here: guessing one would be worse
 * than sending the guardian to the plugin, which owns its own setup surface
 * and its own idea of what "connected" means.
 *
 * The description is the plugin manifest's, and a manifest need not carry one,
 * so it is omitted rather than filled with copy this client invented.
 */
export function PluginChannelPanel({
  channel,
  assistantId,
}: PluginChannelPanelProps) {
  const navigate = useNavigate();
  const ingress = useChannelIngress(assistantId, channel.id);

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

      {/* Hidden when the gateway cannot answer: one predating the endpoint, or
          a viewer who is not this assistant's guardian. Neither has a decision
          to offer, and an error banner would report a failure the viewer
          cannot act on. */}
      {ingress.available && ingress.state !== "none" ? (
        <IngressDecision channel={channel} ingress={ingress} />
      ) : null}

      <Button
        onClick={() => navigate(`/assistant/plugins/${channel.id}`)}
        variant="outlined"
      >
        Open {channel.label} settings
      </Button>
    </div>
  );
}

interface IngressDecisionProps {
  channel: PluginChannelSummary;
  ingress: ReturnType<typeof useChannelIngress>;
}

/**
 * The approve / revoke control, and what it is a decision about.
 *
 * The paths are listed rather than summarised: approving opens them to the
 * public internet, so what is being granted should be readable before the
 * click rather than described in the abstract.
 */
function IngressDecision({ channel, ingress }: IngressDecisionProps) {
  const approved = ingress.state === "approved";

  return (
    <div className="flex flex-col items-center gap-3">
      <Tag tone={approved ? "positive" : "neutral"}>
        {approved ? "Ingress approved" : "Ingress awaiting approval"}
      </Tag>

      <p
        className="max-w-[420px] text-body-small-default"
        style={{ color: "var(--content-secondary)" }}
      >
        {approved
          ? `${channel.label} receives messages at these addresses:`
          : `${channel.label} asks to receive messages at these addresses. Until you approve, deliveries to them are refused:`}
      </p>

      <ul className="flex flex-col gap-1">
        {ingress.paths.map((path) => (
          <li
            key={path}
            className="font-mono text-body-small-default"
            style={{ color: "var(--content-secondary)" }}
          >
            {path}
          </li>
        ))}
      </ul>

      <Button
        onClick={approved ? ingress.revoke : ingress.approve}
        disabled={ingress.deciding}
        variant={approved ? "outlined" : "primary"}
      >
        {approved ? "Revoke ingress" : "Approve ingress"}
      </Button>

      {ingress.error ? (
        <p
          className="max-w-[420px] text-body-small-default"
          style={{ color: "var(--system-negative-strong)" }}
        >
          {ingress.error}
        </p>
      ) : null}
    </div>
  );
}
