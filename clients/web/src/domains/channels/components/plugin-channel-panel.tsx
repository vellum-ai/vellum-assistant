import { useNavigate } from "react-router";

import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import {
  useChannelIngress,
  type IngressPath,
} from "@/domains/channels/hooks/use-channel-ingress";
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
  const ingress = useChannelIngress(assistantId, channel.plugin);

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
          cannot act on. A 5xx or a network failure is not that case and keeps
          the control, which reports the failure and retries. */}
      {ingress.available && ingress.state !== "none" ? (
        <IngressDecision channel={channel} ingress={ingress} />
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

interface IngressDecisionProps {
  channel: PluginChannelSummary;
  ingress: ReturnType<typeof useChannelIngress>;
}

/**
 * The approve / revoke control, and what it is a decision about.
 *
 * The addresses are listed rather than summarised: approving opens them to the
 * public internet, so what is being granted should be readable before the
 * click rather than described in the abstract.
 *
 * A declaration can carry addresses the approval does not govern, which the
 * gateway serves whether or not a guardian ever decides. Those are listed
 * apart, because folding them into the refusal would tell a guardian that
 * public ingress is closed while it is open, and because revoking will not
 * close them either.
 */
function IngressDecision({ channel, ingress }: IngressDecisionProps) {
  const approved = ingress.state === "approved";
  const governed = ingress.paths.filter((entry) => entry.approvalGoverned);
  const ungoverned = ingress.paths.filter((entry) => !entry.approvalGoverned);

  return (
    <div className="flex flex-col items-center gap-3">
      <Tag tone={approved ? "positive" : "neutral"}>
        {approved ? "Ingress approved" : "Ingress awaiting approval"}
      </Tag>

      {governed.length > 0 ? (
        <>
          <p
            className="max-w-[420px] text-body-small-default"
            style={{ color: "var(--content-secondary)" }}
          >
            {approved
              ? `${channel.label} receives messages at these addresses:`
              : `${channel.label} asks to receive messages at these addresses. Until you approve, deliveries to them are refused:`}
          </p>
          <PathList paths={governed} />
        </>
      ) : null}

      {ungoverned.length > 0 ? (
        <>
          <p
            className="max-w-[420px] text-body-small-default"
            style={{ color: "var(--content-secondary)" }}
          >
            These addresses are open whatever you decide, because only Vellum
            can reach them:
          </p>
          <PathList paths={ungoverned} />
        </>
      ) : null}

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

function PathList({ paths }: { paths: IngressPath[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {paths.map((entry) => (
        <li
          key={entry.path}
          className="font-mono text-body-small-default"
          style={{ color: "var(--content-secondary)" }}
        >
          {entry.path}
        </li>
      ))}
    </ul>
  );
}
