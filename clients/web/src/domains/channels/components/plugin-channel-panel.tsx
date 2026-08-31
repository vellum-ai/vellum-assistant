import { Info, Plug } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";
import { Tooltip } from "@vellumai/design-library/components/tooltip";

import { ChannelTrustFloorSection } from "@/domains/channels/components/channel-trust-floor-section";
import {
  useChannelIngress,
  type ChannelIngress,
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
 * channel's, and this is the only surface a plugin channel has to make that
 * an explicit choice. And a way through to the plugin, because the built-in
 * adapters each render a credential form this client knows the shape of and a
 * plugin's does not exist here. The plugin page link is a plug icon in the
 * corner of the card, so the decision stays the thing this page settles.
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
    <div className="relative flex flex-col items-center gap-3 py-10 text-center">
      <Button
        className="absolute top-0 right-0"
        variant="ghost"
        size="compact"
        iconOnly={<Plug />}
        tooltip={t("pluginChannelPanel.navigateToPluginPage")}
        aria-label={t("pluginChannelPanel.navigateToPluginPage")}
        onClick={() => navigate(`/assistant/plugins/${channel.plugin}`)}
      />

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
      return <IngressDecision ingress={ingress} />;
  }
}

/**
 * The approve / revoke control, and a short explanation of what it grants.
 *
 * Approving opens the plugin's public ingress to the providers behind this
 * channel. The grant itself is the decision; the addresses and delivery
 * details live on the plugin page, not here.
 */
function IngressDecision({ ingress }: Pick<IngressSectionProps, "ingress">) {
  const { t } = useTranslation("channels");
  const approved = ingress.status === "approved";

  return (
    <div className="flex flex-col items-center gap-3">
      <Tag tone={approved ? "positive" : "neutral"}>
        {approved
          ? t("pluginChannelPanel.ingressApprovedTag")
          : t("pluginChannelPanel.ingressPendingTag")}
      </Tag>

      <div className="flex items-center gap-1.5">
        <Button
          onClick={approved ? ingress.revoke : ingress.approve}
          disabled={ingress.deciding}
          variant={approved ? "outlined" : "primary"}
        >
          {approved
            ? t("pluginChannelPanel.revokeChannel")
            : t("pluginChannelPanel.approveChannel")}
        </Button>
        <Tooltip content={t("pluginChannelPanel.approveChannelInfo")}>
          <span
            tabIndex={0}
            className="inline-flex cursor-default p-0.5 text-[color:var(--content-secondary)]"
            aria-label={t("pluginChannelPanel.approveChannelInfo")}
          >
            <Info className="h-4 w-4" aria-hidden="true" />
          </span>
        </Tooltip>
      </div>

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
