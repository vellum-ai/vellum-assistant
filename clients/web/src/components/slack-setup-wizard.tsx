import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type StepperStep } from "@vellumai/design-library";
import {
  ChannelSetupWizard,
  type MutationStatus,
} from "@/components/channel-setup-wizard";
import { SlackSetupCreateStep } from "@/components/slack-setup-create-step";
import { SlackSetupNameStep } from "@/components/slack-setup-name-step";
import { SlackSetupOpenStep } from "@/components/slack-setup-open-step";
import { SlackSetupTokensStep } from "@/components/slack-setup-tokens-step";
import { useChannelSetupSteps } from "@/hooks/use-channel-setup-steps";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { openExternalUrl } from "@/runtime/browser";
import { buildSlackManifest } from "@/utils/slack-manifest";

export type { MutationStatus };

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
  onSave,
  saveStatus = "idle",
  saveError = null,
}: SlackSetupWizardProps) {
  const { stepId, stepIndex, goTo, onStepSelect } =
    useChannelSetupSteps(WIZARD_STEP_IDS);
  const [slackAppName, setSlackAppName] = useState(assistantName);
  const [description, setDescription] = useState("");
  const userEditedName = useRef(false);

  useEffect(() => {
    if (!userEditedName.current) {
      setSlackAppName(assistantName);
    }
  }, [assistantName]);

  // The exact manifest this wizard last wrote to the clipboard, so the handoff
  // step can tell "never copied" from "copied, then the name changed". The
  // transient `copied` flag resets on a timer and cannot. This is what the
  // wizard did, not what the clipboard now holds: a page cannot read the
  // clipboard without a permission prompt, and a copy in any other app
  // replaces it silently.
  const [copiedManifest, setCopiedManifest] = useState<string | null>(null);

  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");

  // Drop the credentials once they are saved. The Channels page keeps this
  // wizard mounted on success, so without this both tokens stay in their
  // fields, recoverable from a mounted component long after they were handed
  // over. The chat drawer closes on success and unmounts either way.
  useEffect(() => {
    if (saveStatus === "success") {
      setBotToken("");
      setAppToken("");
    }
  }, [saveStatus]);

  const { copy, copied } = useCopyToClipboard({
    errorMessage:
      "Could not copy the manifest. Copy it again before continuing.",
  });

  const manifestJson = useMemo(
    () =>
      JSON.stringify(buildSlackManifest(slackAppName, description), null, 2),
    [slackAppName, description],
  );

  // Whether the manifest for the app as currently named was copied from here.
  // Editing the name or description after a copy invalidates it, so both the
  // handoff notice and the transient "Copied!" label key off this rather than
  // off `copied` alone: the flag survives 1.5s and would otherwise keep
  // confirming a copy of a manifest that no longer exists.
  const manifestCopiedHere = copiedManifest === manifestJson;

  const handleAppNameChange = useCallback((value: string) => {
    userEditedName.current = true;
    setSlackAppName(value);
  }, []);

  const handleCopyManifest = useCallback(() => {
    copy(manifestJson, () => setCopiedManifest(manifestJson));
  }, [copy, manifestJson]);

  const handleOpenSlack = useCallback(() => {
    void openExternalUrl(SLACK_NEW_APP_URL);
  }, []);

  const handleContinueToOpen = useCallback(() => goTo("open"), [goTo]);
  const handleContinueToCreate = useCallback(() => goTo("create"), [goTo]);
  const handleContinueToConnect = useCallback(() => goTo("connect"), [goTo]);

  const handleSave = useCallback(() => {
    onSave?.(botToken.trim(), appToken.trim());
  }, [onSave, botToken, appToken]);

  return (
    <ChannelSetupWizard
      channelLabel="Slack"
      steps={WIZARD_STEPS}
      stepIndex={stepIndex}
      onStepSelect={onStepSelect}
      locked={saveStatus === "pending"}
    >
      {stepId === "name" && (
        <SlackSetupNameStep
          appName={slackAppName}
          description={description}
          copied={copied && manifestCopiedHere}
          onAppNameChange={handleAppNameChange}
          onDescriptionChange={setDescription}
          onCopyManifest={handleCopyManifest}
          onContinue={handleContinueToOpen}
        />
      )}

      {stepId === "open" && (
        <SlackSetupOpenStep
          manifestCopiedHere={manifestCopiedHere}
          copied={copied && manifestCopiedHere}
          onCopyManifest={handleCopyManifest}
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
    </ChannelSetupWizard>
  );
}
