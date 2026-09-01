import { useQuery } from "@tanstack/react-query";

import { Notice } from "@vellumai/design-library";
import { channelverificationsessionsStatusGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";

export interface DiscordSetupFinishStepProps {
  /** Assistant the setup panel was opened for. */
  assistantId: string;
}

/**
 * The wizard's closing state, shown once the user confirms the bot joined a
 * server.
 *
 * The token is stored and the bot is in a server, but unless the guardian's
 * Discord identity is verified, the default admission policy only admits
 * trusted contacts: the bot sees the owner's mentions and declines to answer
 * them. Verification runs in chat (the assistant DMs a code through the bot
 * that was just connected), so this step's job is to hand the user off there
 * instead of letting them leave believing a stored token is a working channel.
 *
 * Whether the handoff is needed comes from the guardian binding, not from
 * assuming a fresh setup: disconnecting Discord clears only the credential
 * and application metadata, so a guardian who reconnects is often still
 * verified and must not be sent back through a flow that would only report
 * the binding already exists.
 */
export function DiscordSetupFinishStep({
  assistantId,
}: DiscordSetupFinishStepProps) {
  const { t } = useTranslation();

  const bindingQuery = useQuery({
    ...channelverificationsessionsStatusGetOptions({
      path: { assistant_id: assistantId },
      query: { channel: "discord" },
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
      <Notice tone="success" title={t("discordSetupFinishStep.connectedTitle")}>
        {t("discordSetupFinishStep.connectedBody")}
      </Notice>

      {verified ? (
        <Notice
          tone="success"
          title={t("discordSetupFinishStep.verifiedTitle")}
        >
          {t("discordSetupFinishStep.verifiedBody")}
        </Notice>
      ) : (
        <Notice tone="warning" title={t("discordSetupFinishStep.verifyTitle")}>
          {t("discordSetupFinishStep.verifyBody")}
        </Notice>
      )}
    </div>
  );
}
