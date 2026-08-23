import { useCallback, useEffect, useMemo, useState } from "react";

import { type StepperStep } from "@vellumai/design-library";
import {
  ChannelSetupWizard,
  type MutationStatus,
} from "@/components/channel-setup-wizard";
import { TelegramSetupConnectStep } from "@/components/telegram-setup-connect-step";
import { TelegramSetupCreateStep } from "@/components/telegram-setup-create-step";
import { useChannelSetupSteps } from "@/hooks/use-channel-setup-steps";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTranslation } from "@/i18n";
import { openExternalUrl } from "@/runtime/browser";

export type { MutationStatus };

const BOTFATHER_URL = "https://t.me/BotFather";

const WIZARD_STEP_IDS = ["create", "connect"] as const;
export type TelegramSetupStepId = (typeof WIZARD_STEP_IDS)[number];

export interface TelegramSetupWizardProps {
  assistantName: string;
  onSave?: (botToken: string) => void;
  saveStatus?: MutationStatus;
  saveError?: string | null;
}

/**
 * Guided setup for connecting a Telegram bot, paced across two steps.
 *
 * Telegram has no manifest to hand over and no permissions to review, so the
 * flow is shorter than Slack's: create the bot in BotFather, then bring its
 * token back. Two steps rather than four, because the intervening beats Slack
 * needs do not exist here.
 */
export function TelegramSetupWizard({
  assistantName,
  onSave,
  saveStatus = "idle",
  saveError = null,
}: TelegramSetupWizardProps) {
  const { t } = useTranslation();
  const WIZARD_STEPS: StepperStep[] = useMemo(
    () => [
      { id: "create", label: t("telegramSetupWizard.stepCreate") },
      { id: "connect", label: t("telegramSetupWizard.stepConnect") },
    ],
    [t],
  );
  const { stepId, stepIndex, goTo, onStepSelect } =
    useChannelSetupSteps(WIZARD_STEP_IDS);
  const [botToken, setBotToken] = useState("");

  // Drop the credential once it is saved. Neither surface unmounts this wizard
  // on success, so without this a submitted bot token stays in the field,
  // recoverable from a mounted component long after it was handed over.
  useEffect(() => {
    if (saveStatus === "success") {
      setBotToken("");
    }
  }, [saveStatus]);

  const { copy, copied } = useCopyToClipboard({
    errorMessage: t("telegramSetupWizard.copyError"),
  });

  const handleCopyName = useCallback(() => {
    copy(assistantName);
  }, [copy, assistantName]);

  const handleOpenBotFather = useCallback(() => {
    void openExternalUrl(BOTFATHER_URL);
  }, []);

  const handleContinueToConnect = useCallback(() => goTo("connect"), [goTo]);

  const handleSave = useCallback(() => {
    onSave?.(botToken.trim());
  }, [onSave, botToken]);

  return (
    <ChannelSetupWizard
      channelLabel={t("telegramSetupWizard.channelLabel")}
      steps={WIZARD_STEPS}
      stepIndex={stepIndex}
      onStepSelect={onStepSelect}
      locked={saveStatus === "pending"}
    >
      {stepId === "create" && (
        <TelegramSetupCreateStep
          suggestedName={assistantName}
          copied={copied}
          onCopyName={handleCopyName}
          onOpenBotFather={handleOpenBotFather}
          onContinue={handleContinueToConnect}
        />
      )}

      {stepId === "connect" && (
        <TelegramSetupConnectStep
          botToken={botToken}
          saveStatus={saveStatus}
          saveError={saveError}
          onBotTokenChange={setBotToken}
          onSave={handleSave}
        />
      )}
    </ChannelSetupWizard>
  );
}
