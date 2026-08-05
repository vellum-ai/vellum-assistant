import { useCallback, useState } from "react";

import { Stepper, type StepperStep } from "@vellumai/design-library";
import { TelegramSetupConnectStep } from "@/components/telegram-setup-connect-step";
import { TelegramSetupCreateStep } from "@/components/telegram-setup-create-step";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

// Duplicated from `slack-setup-wizard.tsx` rather than imported: a Telegram
// component reaching into the Slack wizard for a shared type is the wrong
// dependency. Both move to the shared shell when it is extracted.
export type MutationStatus = "idle" | "pending" | "success" | "error";

const BOTFATHER_URL = "https://t.me/BotFather";

const WIZARD_STEP_IDS = ["create", "connect"] as const;
export type TelegramSetupStepId = (typeof WIZARD_STEP_IDS)[number];

const WIZARD_STEPS: StepperStep[] = [
  { id: "create", label: "Create bot" },
  { id: "connect", label: "Connect" },
];

export interface TelegramSetupWizardProps {
  assistantName: string;
  /**
   * Step to open on. Production always starts at the beginning; stories use
   * this to render a later step without clicking through the earlier ones.
   */
  initialStepId?: TelegramSetupStepId;
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
  initialStepId = "create",
  onSave,
  saveStatus = "idle",
  saveError = null,
}: TelegramSetupWizardProps) {
  const [stepId, setStepId] = useState<TelegramSetupStepId>(initialStepId);
  const [botToken, setBotToken] = useState("");

  const { copy, copied } = useCopyToClipboard({
    errorMessage: "Could not copy the name. Type it into BotFather instead.",
  });

  const stepIndex = WIZARD_STEP_IDS.indexOf(stepId);

  const handleCopyName = useCallback(() => {
    copy(assistantName);
  }, [copy, assistantName]);

  const handleOpenBotFather = useCallback(() => {
    window.open(BOTFATHER_URL, "_blank", "noopener,noreferrer");
  }, []);

  const handleContinueToConnect = useCallback(() => setStepId("connect"), []);

  const handleSave = useCallback(() => {
    onSave?.(botToken.trim());
  }, [onSave, botToken]);

  const handleStepSelect = useCallback(
    (index: number) => {
      if (index < stepIndex) {
        setStepId(WIZARD_STEP_IDS[index]);
      }
    },
    [stepIndex],
  );

  return (
    <div data-slot="telegram-setup-wizard" className="flex flex-col gap-4">
      <Stepper
        steps={WIZARD_STEPS}
        current={stepIndex}
        onStepSelect={handleStepSelect}
        disabled={saveStatus === "pending"}
      />

      <div
        data-slot="telegram-setup-step-panel"
        className="rounded-lg bg-[var(--surface-sunken)] p-4"
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
      </div>
    </div>
  );
}
