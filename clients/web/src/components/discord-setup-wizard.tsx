import { useCallback, useEffect, useMemo, useState } from "react";

import { type StepperStep } from "@vellumai/design-library";
import {
  ChannelSetupWizard,
  type MutationStatus,
} from "@/components/channel-setup-wizard";
import { DiscordSetupConnectStep } from "@/components/discord-setup-connect-step";
import { DiscordSetupCreateStep } from "@/components/discord-setup-create-step";
import { DiscordSetupInviteStep } from "@/components/discord-setup-invite-step";
import { useChannelSetupSteps } from "@/hooks/use-channel-setup-steps";
import { useTranslation } from "@/i18n";
import { openExternalUrl } from "@/runtime/browser";

export type { MutationStatus };

const DISCORD_PORTAL_URL = "https://discord.com/developers/applications";

const WIZARD_STEP_IDS = ["create", "connect", "invite"] as const;

export interface DiscordSetupWizardProps {
  /** Assistant the setup panel was opened for. */
  assistantId: string;
  onSave?: (botToken: string) => void;
  saveStatus?: MutationStatus;
  saveError?: string | null;
  /** The install link, read back from the daemon once the token validates. */
  inviteUrl?: string;
}

/**
 * Guided setup for connecting a Discord bot, paced across three steps.
 *
 * One more step than Telegram because a Discord bot is not reachable until it
 * has been invited to a server, and one fewer beat than Slack because there is
 * a single token rather than a pair.
 */
export function DiscordSetupWizard({
  assistantId,
  onSave,
  saveStatus = "idle",
  saveError = null,
  inviteUrl,
}: DiscordSetupWizardProps) {
  const { t } = useTranslation();
  const WIZARD_STEPS: StepperStep[] = useMemo(
    () => [
      { id: "create", label: t("discordSetupWizard.stepCreate") },
      { id: "connect", label: t("discordSetupWizard.stepConnect") },
      { id: "invite", label: t("discordSetupWizard.stepInvite") },
    ],
    [t],
  );
  const { stepId, stepIndex, goTo, onStepSelect } =
    useChannelSetupSteps(WIZARD_STEP_IDS);
  const [botToken, setBotToken] = useState("");

  // Drop the credential once it is saved, and move on: neither surface
  // unmounts this wizard on success, so the token would otherwise sit in a
  // mounted field long after it was handed over.
  useEffect(() => {
    if (saveStatus === "success") {
      setBotToken("");
      goTo("invite");
    }
  }, [saveStatus, goTo]);

  const handleOpenPortal = useCallback(() => {
    void openExternalUrl(DISCORD_PORTAL_URL);
  }, []);

  const handleOpenInvite = useCallback((url: string) => {
    void openExternalUrl(url);
  }, []);

  const handleContinueToConnect = useCallback(() => goTo("connect"), [goTo]);

  const handleSave = useCallback(() => {
    onSave?.(botToken.trim());
  }, [onSave, botToken]);

  return (
    <ChannelSetupWizard
      channelLabel={t("discordSetupWizard.channelLabel")}
      steps={WIZARD_STEPS}
      stepIndex={stepIndex}
      onStepSelect={onStepSelect}
      locked={saveStatus === "pending"}
    >
      {stepId === "create" && (
        <DiscordSetupCreateStep
          assistantId={assistantId}
          onOpenPortal={handleOpenPortal}
          onContinue={handleContinueToConnect}
        />
      )}

      {stepId === "connect" && (
        <DiscordSetupConnectStep
          botToken={botToken}
          saveStatus={saveStatus}
          saveError={saveError}
          onBotTokenChange={setBotToken}
          onSave={handleSave}
        />
      )}

      {stepId === "invite" && (
        <DiscordSetupInviteStep
          {...(inviteUrl ? { inviteUrl } : {})}
          onOpenInvite={handleOpenInvite}
        />
      )}
    </ChannelSetupWizard>
  );
}
