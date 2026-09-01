import { ChannelSetupCompleteNotice } from "@/components/channel-setup-complete-notice";
import { useTranslation } from "@/i18n";

export interface DiscordSetupFinishStepProps {
  /** Assistant the setup panel was opened for. */
  assistantId: string;
  /**
   * Hands verification to the assistant: the chat drawer records the outcome
   * and closes. Absent on surfaces with no conversation to signal (the
   * Channels tab), where the copy falls back to telling the user what to say.
   */
  onVerifyRequest?: () => void;
}

/**
 * The wizard's closing state, shown once the user confirms the bot joined a
 * server. The Discord side is finished here; what remains is the identity
 * hand-off every channel shares.
 */
export function DiscordSetupFinishStep({
  assistantId,
  onVerifyRequest,
}: DiscordSetupFinishStepProps) {
  const { t } = useTranslation();

  return (
    <ChannelSetupCompleteNotice
      assistantId={assistantId}
      channel="discord"
      savedTitle={t("discordSetupFinishStep.connectedTitle")}
      savedBody={t("discordSetupFinishStep.connectedBody")}
      {...(onVerifyRequest ? { onVerifyRequest } : {})}
    />
  );
}
