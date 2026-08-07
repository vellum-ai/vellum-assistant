import { useNavigate } from "react-router";

import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import {
  useChannelIngress,
  type ChannelIngress,
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
 * Two things belong here. The ingress approval, because a plugin channel's
 * routes are refused until a guardian grants them and this is where someone
 * would look for that. And a way through to the plugin, because the built-in
 * adapters each render a credential form this client knows the shape of and a
 * plugin's does not exist here: guessing one would be worse than sending the
 * guardian to the plugin, which owns its own setup surface and its own idea of
 * what "connected" means. The link sits last, under the decision, because the
 * decision is what this page can settle and the plugin page is where someone
 * goes next.
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

      <IngressSection channel={channel} ingress={ingress} />

      <Button
        onClick={() => navigate(`/assistant/plugins/${channel.plugin}`)}
        variant="outlined"
      >
        Open plugin page
      </Button>
    </div>
  );
}

interface IngressSectionProps {
  channel: PluginChannelSummary;
  ingress: ChannelIngress;
}

/**
 * Where the ingress approval always shows up, whatever there is to say.
 *
 * A plugin channel is a channel someone reaches from outside, so "can anyone
 * reach it" is the question this panel exists to answer. Rendering the section
 * only when there is a decision to make would leave every other case looking
 * like the feature is missing, when what is missing is the answer.
 *
 * The switch is exhaustive over {@link IngressStatus} rather than a chain of
 * guards, so a state that is not a settled answer cannot fall through into one
 * that reads like one.
 */
function IngressSection({ channel, ingress }: IngressSectionProps) {
  switch (ingress.status) {
    case "loading":
      return <Note>Checking who can reach {channel.label}…</Note>;

    case "unsupported":
      // Says nothing about who is viewing: this gateway has no such endpoint,
      // which is equally true for the guardian.
      return (
        <Note>
          This assistant&apos;s gateway does not report ingress approvals, so
          there is nothing to decide here.
        </Note>
      );

    case "forbidden":
      return (
        <Note>
          Only this assistant&apos;s guardian can see or change ingress
          approvals.
        </Note>
      );

    case "unreadable":
      // Transient, and the query is retrying. Reporting it beats presenting a
      // failed read as a settled answer about what the gateway declares.
      return (
        <Note>
          Could not read the ingress approval for {channel.label}.
          {ingress.error ? ` ${ingress.error}` : ""}
        </Note>
      );

    case "none":
      // Every plugin channel declares ingress, so reaching this means the
      // gateway has not seen the declaration: a plugin installed since it last
      // scanned, or a manifest it rejected.
      return (
        <Note>
          The gateway sees no ingress declaration for {channel.label}, so there
          is nothing to approve yet.
        </Note>
      );

    case "pending":
    case "approved":
      return <IngressDecision channel={channel} ingress={ingress} />;
  }
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
function IngressDecision({ channel, ingress }: IngressSectionProps) {
  const approved = ingress.status === "approved";
  const governed = ingress.paths.filter((entry) => entry.approvalGoverned);
  const ungoverned = ingress.paths.filter((entry) => !entry.approvalGoverned);

  return (
    <div className="flex flex-col items-center gap-3">
      <Tag tone={approved ? "positive" : "neutral"}>
        {approved ? "Ingress approved" : "Ingress awaiting approval"}
      </Tag>

      {governed.length > 0 ? (
        <>
          <Note>
            {approved
              ? `${channel.label} receives messages at these addresses:`
              : `${channel.label} asks to receive messages at these addresses. Until you approve, deliveries to them are refused:`}
          </Note>
          <PathList paths={governed} />
        </>
      ) : null}

      {ungoverned.length > 0 ? (
        <>
          <Note>
            These addresses are open whatever you decide, because only Vellum
            can reach them:
          </Note>
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

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="max-w-[420px] text-body-small-default"
      style={{ color: "var(--content-secondary)" }}
    >
      {children}
    </p>
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
