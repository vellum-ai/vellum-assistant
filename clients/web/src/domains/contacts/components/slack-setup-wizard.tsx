import { ExternalLink, Plus } from "lucide-react";
import { useCallback, useState } from "react";

import { Button, Card, Input, Radio, RadioGroup, Stepper, type StepperStep, Typography } from "@vellumai/design-library";

import { publicAsset } from "@/utils/public-asset";
import { buildSlackManifestUrl } from "@/utils/slack-manifest";

export type SlackThreadMode = "mention_only" | "mention_then_thread";

const WIZARD_STEP_IDS = ["create-app", "app-token", "install-app", "bot-token"] as const;
type WizardStepId = (typeof WIZARD_STEP_IDS)[number];

const WIZARD_STEPS: StepperStep[] = [
  { id: "create-app", label: "1. Create App" },
  { id: "app-token", label: "2. Generate App Token" },
  { id: "install-app", label: "3. Install App" },
  { id: "bot-token", label: "4. Add Bot Token" },
];

export interface SlackSetupWizardProps {
  assistantName: string;
  initialStepId?: WizardStepId;
  connected?: boolean;
  threadMode?: SlackThreadMode;
  threadModePending?: boolean;
  onThreadModeChange?: (mode: SlackThreadMode) => void;
  onSave?: (botToken: string, appToken: string) => Promise<void>;
}

export function SlackSetupWizard({
  assistantName,
  initialStepId = "create-app",
  connected = false,
  threadMode,
  threadModePending = false,
  onThreadModeChange,
  onSave,
}: SlackSetupWizardProps) {
  const [stepId, setStepId] = useState<WizardStepId>(initialStepId);
  const [slackAppName, setSlackAppName] = useState(assistantName);
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stepIndex = WIZARD_STEP_IDS.indexOf(stepId);

  const handleCreateApp = useCallback(() => {
    const name = slackAppName.trim() || "My Assistant";
    const url = buildSlackManifestUrl(name);
    window.open(url, "_blank", "noopener,noreferrer");
  }, [slackAppName]);

  const handleSave = useCallback(async () => {
    if (!onSave || !botToken.trim() || !appToken.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(botToken.trim(), appToken.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [onSave, botToken, appToken]);

  const handleStepSelect = useCallback(
    (index: number) => {
      if (index < stepIndex) {
        setStepId(WIZARD_STEP_IDS[index]);
      }
    },
    [stepIndex],
  );

  const goNext = useCallback(() => {
    const next = stepIndex + 1;
    if (next < WIZARD_STEP_IDS.length) {
      setStepId(WIZARD_STEP_IDS[next]);
    }
  }, [stepIndex]);

  if (connected) {
    return (
      <div className="pl-7" data-slot="slack-setup-wizard">
        <Card.Root>
          <Card.Header>
            <div className="flex items-center gap-3">
              <img
                src={publicAsset("/images/integrations/slack.svg")}
                alt=""
                className="size-8 rounded-lg bg-[var(--surface-sunken)] p-1"
              />
              <div className="flex flex-col">
                <Typography as="span" variant="body-medium-default">
                  Slack settings
                </Typography>
                <span className="flex items-center gap-1.5 text-body-small-default text-[var(--content-secondary)]">
                  <span className="size-2 rounded-full bg-[var(--system-positive-strong)]" />
                  Connected as {assistantName}
                </span>
              </div>
            </div>
          </Card.Header>
          <Card.Body>
            <div className="flex flex-col gap-3">
              <Typography
                as="span"
                variant="body-small-emphasised"
                className="text-[color:var(--content-secondary)]"
              >
                Thread Behavior
              </Typography>
              <RadioGroup<SlackThreadMode>
                value={threadMode ?? "mention_then_thread"}
                onValueChange={(next) => onThreadModeChange?.(next)}
                disabled={threadModePending || !onThreadModeChange}
                aria-label="Slack thread behavior"
              >
                <Radio<SlackThreadMode>
                  value="mention_only"
                  label="Mentions only"
                  helperText="Bot only responds when @mentioned."
                />
                <Radio<SlackThreadMode>
                  value="mention_then_thread"
                  label="Follow threads after first mention"
                  helperText="After an @mention in a thread, bot listens to all subsequent replies."
                />
              </RadioGroup>
            </div>
          </Card.Body>
        </Card.Root>
      </div>
    );
  }

  return (
    <div className="pl-7" data-slot="slack-setup-wizard">
      <Card.Root>
        <Card.Header>
          <div className="flex items-center gap-3">
            <img
              src={publicAsset("/images/integrations/slack.svg")}
              alt=""
              className="size-8 rounded-lg bg-[var(--surface-sunken)] p-1"
            />
            <span>Slack setup</span>
          </div>
        </Card.Header>
        <Card.Body>
          <div className="flex flex-col gap-4">
            <Stepper
              steps={WIZARD_STEPS}
              current={stepIndex}
              onStepSelect={handleStepSelect}
              disabled={saving}
            />

            <div className="rounded-lg bg-[var(--surface-sunken)] p-4">
              {stepId === "create-app" && (
                <CreateAppStep
                  slackAppName={slackAppName}
                  onSlackAppNameChange={setSlackAppName}
                  onCreateApp={handleCreateApp}
                  onNext={goNext}
                />
              )}

              {stepId === "app-token" && (
                <AppTokenStep
                  appToken={appToken}
                  onAppTokenChange={setAppToken}
                  onNext={goNext}
                />
              )}

              {stepId === "install-app" && (
                <InstallAppStep onNext={goNext} />
              )}

              {stepId === "bot-token" && (
                <BotTokenStep
                  botToken={botToken}
                  saving={saving}
                  error={error}
                  onBotTokenChange={setBotToken}
                  onSave={handleSave}
                />
              )}
            </div>
          </div>
        </Card.Body>
      </Card.Root>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Create Slack App
// ---------------------------------------------------------------------------

interface CreateAppStepProps {
  slackAppName: string;
  onSlackAppNameChange: (value: string) => void;
  onCreateApp: () => void;
  onNext: () => void;
}

function CreateAppStep({ slackAppName, onSlackAppNameChange, onCreateApp, onNext }: CreateAppStepProps) {
  const nameValid = slackAppName.trim().length > 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body-medium-lighter text-[var(--content-default)]">
        Name your Slack app, then click below to create it:
      </p>
      <Input
        label="App Name"
        value={slackAppName}
        onChange={(e) => onSlackAppNameChange(e.target.value.slice(0, 35))}
        placeholder="My Assistant"
        fullWidth
      />
      <div className="flex items-center">
        <Button
          type="button"
          disabled={!nameValid}
          onClick={() => {
            onCreateApp();
            onNext();
          }}
          leftIcon={<Plus aria-hidden className="size-4" />}
          rightIcon={<ExternalLink aria-hidden className="size-4" />}
        >
          Add Slack App
        </Button>
      </div>
      <div className="flex justify-end">
        <Button type="button" variant="primary" onClick={onNext}>
          Next &gt;
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Generate App Token
// ---------------------------------------------------------------------------

interface AppTokenStepProps {
  appToken: string;
  onAppTokenChange: (value: string) => void;
  onNext: () => void;
}

function AppTokenStep({
  appToken,
  onAppTokenChange,
  onNext,
}: AppTokenStepProps) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body-medium-lighter text-[var(--content-default)]">
        Go to <strong>Basic Information</strong> &rarr;{" "}
        <strong>App-Level Tokens</strong> and generate a token with the{" "}
        <strong>connections:write</strong> scope. Copy the token that starts
        with <strong>xapp-</strong>.
      </p>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Input
            label="App Token"
            type="password"
            value={appToken}
            onChange={(e) => onAppTokenChange(e.target.value)}
            placeholder="xapp-..."
            fullWidth
          />
        </div>
        <Button
          type="button"
          variant="primary"
          onClick={onNext}
          disabled={!appToken.trim()}
        >
          Next &gt;
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Install App
// ---------------------------------------------------------------------------

interface InstallAppStepProps {
  onNext: () => void;
}

function InstallAppStep({ onNext }: InstallAppStepProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="text-body-medium-lighter text-[var(--content-default)]">
          Go to <strong>Install App</strong> &rarr;{" "}
          <strong>Install to Workspace</strong> and approve the app permissions.
        </p>
        <p className="text-body-medium-lighter text-[var(--content-faint)]">
          If Slack shows Request approval, a workspace admin needs to approve it
          first.
        </p>
      </div>
      <div className="flex justify-end">
        <Button type="button" variant="primary" onClick={onNext}>
          Next &gt;
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Bot Token
// ---------------------------------------------------------------------------

interface BotTokenStepProps {
  botToken: string;
  saving: boolean;
  error: string | null;
  onBotTokenChange: (value: string) => void;
  onSave: () => void;
}

function BotTokenStep({
  botToken,
  saving,
  error,
  onBotTokenChange,
  onSave,
}: BotTokenStepProps) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body-medium-lighter text-[var(--content-default)]">
        After install, copy the <strong>Bot User OAuth Token</strong> that
        starts with <strong>xoxb-</strong>.
      </p>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Input
            label="Bot Token"
            type="password"
            value={botToken}
            onChange={(e) => onBotTokenChange(e.target.value)}
            placeholder="xoxb-..."
            fullWidth
          />
        </div>
        <Button
          type="button"
          variant="primary"
          onClick={onSave}
          disabled={!botToken.trim() || saving}
        >
          {saving ? "Saving\u2026" : "Save"}
        </Button>
      </div>
      {error ? (
        <p className="text-body-small-default text-[var(--system-negative-strong)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
