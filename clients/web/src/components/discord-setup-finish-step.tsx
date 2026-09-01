import { Notice } from "@vellumai/design-library";
import { useTranslation } from "@/i18n";

/**
 * The wizard's closing state, shown once the user confirms the bot joined a
 * server.
 *
 * The token is stored and the bot is in a server, but the guardian's Discord
 * identity is not yet verified, and the default admission policy only admits
 * trusted contacts: the bot sees the owner's mentions and declines to answer
 * them. Verification runs in chat (the assistant DMs a code through the bot
 * that was just connected), so this step's job is to hand the user off there
 * instead of letting them leave believing a stored token is a working channel.
 */
export function DiscordSetupFinishStep() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="success" title={t("discordSetupFinishStep.connectedTitle")}>
        {t("discordSetupFinishStep.connectedBody")}
      </Notice>

      <Notice tone="warning" title={t("discordSetupFinishStep.verifyTitle")}>
        {t("discordSetupFinishStep.verifyBody")}
      </Notice>
    </div>
  );
}
