import { useCallback, useEffect, useMemo, useState } from "react";

import { type StepperStep } from "@vellumai/design-library";
import {
  ChannelSetupWizard,
  type MutationStatus,
} from "@/components/channel-setup-wizard";
import { DiscordSetupConnectStep } from "@/components/discord-setup-connect-step";
import { DiscordSetupCreateStep } from "@/components/discord-setup-create-step";
import { DiscordSetupFinishStep } from "@/components/discord-setup-finish-step";
import { DiscordSetupInviteStep } from "@/components/discord-setup-invite-step";
import { useChannelSetupSteps } from "@/hooks/use-channel-setup-steps";
import { useClearOnSaveSuccess } from "@/hooks/use-clear-on-save-success";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTranslation } from "@/i18n";
import { openExternalUrl } from "@/runtime/browser";

export type { MutationStatus };

const DISCORD_PORTAL_URL = "https://discord.com/developers/applications";

const WIZARD_STEP_IDS = ["create", "connect", "invite", "finish"] as const;

export interface DiscordSetupWizardProps {
  /** Assistant the setup panel was opened for. */
  assistantId: string;
  /** Suggested app name, offered to copy when the portal asks for one. */
  assistantName: string;
  onSave?: (botToken: string) => void;
  saveStatus?: MutationStatus;
  saveError?: string | null;
  /** The install link, read back from the daemon once the token validates. */
  inviteUrl?: string;
  /**
   * Hands identity verification to the assistant from the finish step. Only
   * the chat drawer can offer it (it signals the originating conversation);
   * without it the finish step tells the user what to say in chat instead.
   */
  onVerifyRequest?: () => void;
}

/**
 * Guided setup for connecting a Discord bot, paced across four steps.
 *
 * More steps than Telegram because a Discord bot is not reachable until it
 * has been invited to a server, and joining is only observable as the user's
 * own confirmation: Discord authorizes in a popup this app cannot see, and
 * the token is dropped after save rather than kept around to poll with. The
 * finish step lives here rather than in the invite step because it completes
 * the whole wizard, and both surfaces that mount this component keep it
 * mounted after the token saves, so wizard-owned completion reaches both.
 */
export function DiscordSetupWizard({
  assistantId,
  assistantName,
  onSave,
  saveStatus = "idle",
  saveError = null,
  inviteUrl,
  onVerifyRequest,
}: DiscordSetupWizardProps) {
  const { t } = useTranslation();
  const WIZARD_STEPS: StepperStep[] = useMemo(
    () => [
      { id: "create", label: t("discordSetupWizard.stepCreate") },
      { id: "connect", label: t("discordSetupWizard.stepConnect") },
      { id: "invite", label: t("discordSetupWizard.stepInvite") },
      { id: "finish", label: t("discordSetupWizard.stepFinish") },
    ],
    [t],
  );
  const { stepId, stepIndex, goTo, onStepSelect } =
    useChannelSetupSteps(WIZARD_STEP_IDS);
  const [botToken, setBotToken] = useState("");

  useClearOnSaveSuccess(saveStatus, setBotToken);

  // A stored token retires the credential step, so the wizard moves to the
  // action that is actually left.
  useEffect(() => {
    if (saveStatus === "success") {
      goTo("invite");
    }
  }, [saveStatus, goTo]);

  const { copy, copied } = useCopyToClipboard({
    errorMessage: t("discordSetupWizard.copyError"),
  });

  const handleCopyName = useCallback(() => {
    copy(assistantName);
  }, [copy, assistantName]);

  const handleOpenPortal = useCallback(() => {
    void openExternalUrl(DISCORD_PORTAL_URL);
  }, []);

  const handleOpenInvite = useCallback((url: string) => {
    void openExternalUrl(url);
  }, []);

  const handleContinueToConnect = useCallback(() => goTo("connect"), [goTo]);

  const handleConfirmJoined = useCallback(() => goTo("finish"), [goTo]);

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
          suggestedName={assistantName}
          copied={copied}
          onCopyName={handleCopyName}
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
          onConfirmJoined={handleConfirmJoined}
        />
      )}

      {stepId === "finish" && (
        <DiscordSetupFinishStep
          assistantId={assistantId}
          {...(onVerifyRequest ? { onVerifyRequest } : {})}
        />
      )}
    </ChannelSetupWizard>
  );
}
