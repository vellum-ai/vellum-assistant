import { useNavigate } from "react-router";

import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

import { ChannelTrustFloorSection } from "@/domains/channels/components/channel-trust-floor-section";
import {
  useChannelIngress,
  type ChannelIngress,
  type IngressPath,
} from "@/domains/channels/hooks/use-channel-ingress";
import { usePluginChannelTrustFloor } from "@/domains/channels/hooks/use-plugin-channel-trust-floor";
import { useTranslation } from "@/i18n";
import { PluginChannelIcon } from "@/utils/channel-presentation";
import type { PluginChannelSummary } from "@/types/channel-types";

export interface PluginChannelPanelProps {
  channel: PluginChannelSummary;
  assistantId: string;
  assistantDisplayName: string;
}

/**
 * Detail panel for a channel a plugin brings.
 *
 * Three things belong here. The ingress approval, because a plugin channel's
 * routes are refused until a guardian grants them and this is where someone
 * would look for that. Who may message the assistant once they are open,
 * because a plugin channel's floor seeds stricter than any other inbound
 * channel's — strict enough that a fresh install turns away its first message —
 * and this is the only surface a plugin channel has to make that an explicit
 * choice rather than a wall. And a way through to the plugin, because the built-in
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
  assistantDisplayName,
}: PluginChannelPanelProps) {
  const { t } = useTranslation("channels");
  const navigate = useNavigate();
  const ingress = useChannelIngress(assistantId, channel.plugin);
  const trustFloor = usePluginChannelTrustFloor(assistantId);

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

      {trustFloor.onChange ? (
        <div className="w-full max-w-[420px] text-left">
          <ChannelTrustFloorSection
            assistantDisplayName={assistantDisplayName}
            policy={trustFloor.policy}
            saving={trustFloor.isSaving}
            loading={trustFloor.isLoading}
            error={trustFloor.isError}
            onChange={trustFloor.onChange}
          />
        </div>
      ) : null}

      <Button
        onClick={() => navigate(`/assistant/plugins/${channel.plugin}`)}
        variant="outlined"
      >
        {t("pluginChannelPanel.openPluginPage")}
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
  const { t } = useTranslation("channels");
  switch (ingress.status) {
    case "loading":
      return (
        <Note>
          {t("pluginChannelPanel.ingressLoading", { channel: channel.label })}
        </Note>
      );

    case "unsupported":
      // Says nothing about who is viewing: this gateway has no such endpoint,
      // which is equally true for the guardian.
      return <Note>{t("pluginChannelPanel.ingressUnsupported")}</Note>;

    case "forbidden":
      return <Note>{t("pluginChannelPanel.ingressForbidden")}</Note>;

    case "unreadable":
      // Transient, and the query is retrying. Reporting it beats presenting a
      // failed read as a settled answer about what the gateway declares.
      return (
        <Note>
          {t("pluginChannelPanel.ingressUnreadable", {
            channel: channel.label,
          })}
          {ingress.error ? ` ${ingress.error}` : ""}
        </Note>
      );

    case "none":
      // Every plugin channel declares ingress, so reaching this means the
      // gateway has not seen the declaration: a plugin installed since it last
      // scanned, or a manifest it rejected.
      return (
        <Note>
          {t("pluginChannelPanel.ingressNone", { channel: channel.label })}
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
 *
 * Whether any of them starts conversations is said outright. Opening an
 * address a plugin receives callbacks on and letting that address put messages
 * in front of the assistant are different decisions, and this is the only
 * place the second one is ever made.
 */
function IngressDecision({ channel, ingress }: IngressSectionProps) {
  const { t } = useTranslation("channels");
  const approved = ingress.status === "approved";
  const governed = ingress.paths.filter((entry) => entry.approvalGoverned);
  const ungoverned = ingress.paths.filter((entry) => !entry.approvalGoverned);
  const delivers = governed.some((entry) => entry.deliversInbound);

  return (
    <div className="flex flex-col items-center gap-3">
      <Tag tone={approved ? "positive" : "neutral"}>
        {approved
          ? t("pluginChannelPanel.ingressApprovedTag")
          : t("pluginChannelPanel.ingressPendingTag")}
      </Tag>

      {governed.length > 0 ? (
        <>
          <Note>
            {approved
              ? t("pluginChannelPanel.approvedAddresses", {
                  channel: channel.label,
                })
              : t("pluginChannelPanel.pendingAddresses", {
                  channel: channel.label,
                })}
          </Note>
          <PathList paths={governed} />
          {delivers ? (
            <Note>
              {t("pluginChannelPanel.deliversInbound", {
                channel: channel.label,
              })}
            </Note>
          ) : null}
        </>
      ) : null}

      {ungoverned.length > 0 ? (
        <>
          <Note>{t("pluginChannelPanel.ungovernedAddresses")}</Note>
          <PathList paths={ungoverned} />
        </>
      ) : null}

      <Button
        onClick={approved ? ingress.revoke : ingress.approve}
        disabled={ingress.deciding}
        variant={approved ? "outlined" : "primary"}
      >
        {approved
          ? t("pluginChannelPanel.revokeIngress")
          : t("pluginChannelPanel.approveIngress")}
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
