import { useQuery } from "@tanstack/react-query";

import { Button, Notice } from "@vellumai/design-library";
import { channelverificationsessionsStatusGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { getChannelLabel } from "@/utils/channel-presentation";

/** Channels whose setup wizard ends in this notice. */
export type VerifiableSetupChannel = "discord" | "slack" | "telegram";

export interface ChannelSetupCompleteNoticeProps {
  /** Assistant the setup panel was opened for. */
  assistantId: string;
  channel: VerifiableSetupChannel;
  /** What the wizard saved, named in the channel's own terms. */
  savedTitle: string;
  savedBody: string;
  /**
   * Hands verification to the assistant. Only surfaces with a conversation to
   * signal can offer it; without it the copy tells the user what to say.
   */
  onVerifyRequest?: () => void;
}

/**
 * How every channel setup wizard ends: what was saved, then whether anything
 * stands between the user and a channel that answers them.
 *
 * Saving a credential is not the end of setup. Until the guardian's identity
 * on that channel is verified, the default admission policy leaves the bot
 * seeing their messages and declining to answer, which reads as a channel
 * that silently does not work. Verification runs in chat, so this hands the
 * user there rather than letting them leave believing a stored token is a
 * working channel.
 *
 * The verdict comes from the guardian binding rather than from assuming a
 * fresh setup. Disconnecting a channel clears its credential and application
 * metadata but not the binding, so a guardian who reconnects is often still
 * verified and must not be sent back through a flow that would only report
 * that the binding already exists.
 */
export function ChannelSetupCompleteNotice({
  assistantId,
  channel,
  savedTitle,
  savedBody,
  onVerifyRequest,
}: ChannelSetupCompleteNoticeProps) {
  const { t } = useTranslation();
  const channelLabel = getChannelLabel(channel);

  const bindingQuery = useQuery({
    ...channelverificationsessionsStatusGetOptions({
      path: { assistant_id: assistantId },
      query: { channel },
    }),
    // The route publishes no response schema, so the read stays narrow: one
    // boolean, false whenever the payload is not the shape the daemon writes.
    select: (data) =>
      typeof data === "object" &&
      data !== null &&
      (data as { bound?: unknown }).bound === true,
  });
  const verified = bindingQuery.data === true;

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="success" title={savedTitle}>
        {savedBody}
      </Notice>

      {verified ? (
        <Notice
          tone="success"
          title={t("channelSetupCompleteNotice.verifiedTitle")}
        >
          {t("channelSetupCompleteNotice.verifiedBody", {
            channel: channelLabel,
          })}
        </Notice>
      ) : (
        <Notice
          tone="info"
          title={t("channelSetupCompleteNotice.verifyTitle")}
          {...(onVerifyRequest
            ? {
                actions: (
                  <Button
                    type="button"
                    size="compact"
                    onClick={onVerifyRequest}
                  >
                    {t("channelSetupCompleteNotice.verifyAction")}
                  </Button>
                ),
              }
            : {})}
        >
          {onVerifyRequest
            ? t("channelSetupCompleteNotice.verifyActionBody", {
                channel: channelLabel,
              })
            : t("channelSetupCompleteNotice.verifyBody", {
                channel: channelLabel,
              })}
        </Notice>
      )}
    </div>
  );
}
