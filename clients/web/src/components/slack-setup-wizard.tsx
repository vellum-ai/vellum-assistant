import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Stepper, type StepperStep } from "@vellumai/design-library";
import { SlackSetupCreateStep } from "@/components/slack-setup-create-step";
import { SlackSetupNameStep } from "@/components/slack-setup-name-step";
import { SlackSetupOpenStep } from "@/components/slack-setup-open-step";
import { SlackSetupTokensStep } from "@/components/slack-setup-tokens-step";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { buildSlackManifest } from "@/utils/slack-manifest";

export type MutationStatus = "idle" | "pending" | "success" | "error";

/**
 * Slack's create-app entry point. Deliberately carries no `manifest_json`
 * payload: Slack's modal intercepts this URL and ignores the parameter, so
 * the manifest travels via the clipboard instead.
 */
const SLACK_NEW_APP_URL = "https://api.slack.com/apps?new_app=1";

const WIZARD_STEP_IDS = ["name", "open", "create", "connect"] as const;
export type SlackSetupStepId = (typeof WIZARD_STEP_IDS)[number];

const WIZARD_STEPS: StepperStep[] = [
  { id: "name", label: "Name" },
  { id: "open", label: "Open" },
  { id: "create", label: "Create" },
  { id: "connect", label: "Connect" },
];

export interface SlackSetupWizardProps {
  assistantName: string;
  /**
   * Step to open on. Production always starts at the beginning; stories use
   * this to render a later step without clicking through the earlier ones.
   */
  initialStepId?: SlackSetupStepId;
  onSave?: (botToken: string, appToken: string) => void;
  saveStatus?: MutationStatus;
  saveError?: string | null;
}

/**
 * Guided setup for connecting a Slack app, paced across four steps.
 *
 * Slack's create-app modal ignores manifest deep links and mints both the bot
 * and app-level tokens itself on Create and Install. That makes the flow one
 * round trip: configure the app here, hand its manifest to Slack's "From a
 * manifest" option, then bring both tokens back. The steps follow that shape
 * rather than Slack's old settings pages. Settings for an already-connected
 * Slack (thread behavior) live in `SlackThreadBehavior`.
 */
export function SlackSetupWizard({
  assistantName,
  initialStepId = "name",
  onSave,
  saveStatus = "idle",
  saveError = null,
}: SlackSetupWizardProps) {
  const [stepId, setStepId] = useState<SlackSetupStepId>(initialStepId);
  const [slackAppName, setSlackAppName] = useState(assistantName);
  const [description, setDescription] = useState("");
  const userEditedName = useRef(false);

  useEffect(() => {
    if (!userEditedName.current) {
      setSlackAppName(assistantName);
    }
  }, [assistantName]);

  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");

  const { copy, copied } = useCopyToClipboard({
    errorMessage:
      "Could not copy the manifest. Copy it again before continuing.",
  });

  const manifestJson = useMemo(
    () =>
      JSON.stringify(buildSlackManifest(slackAppName, description), null, 2),
    [slackAppName, description],
  );

  const stepIndex = WIZARD_STEP_IDS.indexOf(stepId);

  const handleAppNameChange = useCallback((value: string) => {
    userEditedName.current = true;
    setSlackAppName(value);
  }, []);

  const handleCopyManifest = useCallback(() => {
    copy(manifestJson);
  }, [copy, manifestJson]);

  const handleOpenSlack = useCallback(() => {
    window.open(SLACK_NEW_APP_URL, "_blank", "noopener,noreferrer");
  }, []);

  const handleContinueToOpen = useCallback(() => setStepId("open"), []);
  const handleContinueToCreate = useCallback(() => setStepId("create"), []);
  const handleContinueToConnect = useCallback(() => setStepId("connect"), []);

  const handleSave = useCallback(() => {
    onSave?.(botToken.trim(), appToken.trim());
  }, [onSave, botToken, appToken]);

  const handleStepSelect = useCallback(
    (index: number) => {
      if (index < stepIndex) {
        setStepId(WIZARD_STEP_IDS[index]);
      }
    },
    [stepIndex],
  );

  return (
    <div data-slot="slack-setup-wizard" className="flex flex-col gap-4">
      <Stepper
        steps={WIZARD_STEPS}
        current={stepIndex}
        onStepSelect={handleStepSelect}
        disabled={saveStatus === "pending"}
      />

      <div
        data-slot="slack-setup-step-panel"
        className="rounded-lg bg-[var(--surface-sunken)] p-4"
      >
        {stepId === "name" && (
          <SlackSetupNameStep
            appName={slackAppName}
            description={description}
            copied={copied}
            onAppNameChange={handleAppNameChange}
            onDescriptionChange={setDescription}
            onCopyManifest={handleCopyManifest}
            onContinue={handleContinueToOpen}
          />
        )}

        {stepId === "open" && (
          <SlackSetupOpenStep
            onOpenSlack={handleOpenSlack}
            onContinue={handleContinueToCreate}
          />
        )}

        {stepId === "create" && (
          <SlackSetupCreateStep onContinue={handleContinueToConnect} />
        )}

        {stepId === "connect" && (
          <SlackSetupTokensStep
            botToken={botToken}
            appToken={appToken}
            saveStatus={saveStatus}
            saveError={saveError}
            onBotTokenChange={setBotToken}
            onAppTokenChange={setAppToken}
            onSave={handleSave}
          />
        )}
      </div>
    </div>
  );
}
