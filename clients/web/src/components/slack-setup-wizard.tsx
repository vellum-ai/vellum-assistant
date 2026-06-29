import { ExternalLink, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button, Input, Radio, RadioGroup, Stepper, type StepperStep, Typography } from "@vellumai/design-library";
import { buildSlackManifestUrl } from "@/utils/slack-manifest";

export type SlackThreadMode = "mention_only" | "mention_then_thread";

const WIZARD_STEP_IDS = ["create-app", "app-token", "install-and-connect"] as const;
type WizardStepId = (typeof WIZARD_STEP_IDS)[number];

const WIZARD_STEPS: StepperStep[] = [
  { id: "create-app", label: "Create App" },
  { id: "app-token", label: "App Token" },
  { id: "install-and-connect", label: "Install & Connect" },
];

export interface SlackSetupWizardProps {
  assistantName: string;
  initialStepId?: WizardStepId;
  connected?: boolean;
  /** Compact stepper for constrained containers (e.g. side drawer). */
  compact?: boolean;
  threadMode?: SlackThreadMode;
  threadModePending?: boolean;
  onThreadModeChange?: (mode: SlackThreadMode) => void;
  onSave?: (botToken: string, appToken: string) => Promise<void>;
}

export function SlackSetupWizard({
  assistantName,
  initialStepId = "create-app",
  connected = false,
  compact = false,
  threadMode,
  threadModePending = false,
  onThreadModeChange,
  onSave,
}: SlackSetupWizardProps) {
  const [stepId, setStepId] = useState<WizardStepId>(initialStepId);
  const [slackAppName, setSlackAppName] = useState(assistantName);
  const userEditedName = useRef(false);

  useEffect(() => {
    if (!userEditedName.current) setSlackAppName(assistantName);
  }, [assistantName]);

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
      <div data-slot="slack-setup-wizard">
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
      </div>
    );
  }

  return (
    <div data-slot="slack-setup-wizard">
      <div className="flex flex-col gap-4">
        <Stepper
          steps={WIZARD_STEPS}
          current={stepIndex}
          onStepSelect={handleStepSelect}
          disabled={saving}
          compact={compact}
        />

        <div className="rounded-lg bg-[var(--surface-sunken)] p-4">
          {stepId === "create-app" && (
            <CreateAppStep
              slackAppName={slackAppName}
              onSlackAppNameChange={(v) => { userEditedName.current = true; setSlackAppName(v); }}
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

          {stepId === "install-and-connect" && (
            <InstallAndConnectStep
              botToken={botToken}
              saving={saving}
              error={error}
              onBotTokenChange={setBotToken}
              onSave={handleSave}
            />
          )}
        </div>
      </div>
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
        Name your Slack app, then click below to create it. All permissions and
        settings will be pre-configured automatically.
      </p>
      <Input
        label="App Name"
        value={slackAppName}
        onChange={(e) => onSlackAppNameChange(e.target.value.slice(0, 35))}
        placeholder="My Assistant"
        fullWidth
      />
      <div className="flex items-center gap-3">
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
          Create Slack App
        </Button>
      </div>
      <p className="text-body-small-default text-[var(--content-faint)]">
        Already have a Slack app?{" "}
        <button
          type="button"
          className="text-[var(--content-link)] hover:underline"
          onClick={onNext}
        >
          Skip to next step
        </button>
      </p>
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
        On your app&apos;s settings page in Slack:
      </p>
      <ol className="list-decimal list-inside space-y-1 text-body-medium-lighter text-[var(--content-default)]">
        <li>Go to <strong>Basic Information</strong> &rarr; <strong>App-Level Tokens</strong></li>
        <li>Click <strong>Generate Token and Scopes</strong></li>
        <li>Name it anything (e.g. &ldquo;socket&rdquo;) and add the <strong>connections:write</strong> scope</li>
        <li>Click <strong>Generate</strong> and copy the token</li>
      </ol>
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
// Step 3 — Install & Connect
// ---------------------------------------------------------------------------

interface InstallAndConnectStepProps {
  botToken: string;
  saving: boolean;
  error: string | null;
  onBotTokenChange: (value: string) => void;
  onSave: () => void;
}

function InstallAndConnectStep({
  botToken,
  saving,
  error,
  onBotTokenChange,
  onSave,
}: InstallAndConnectStepProps) {
  return (
    <div className="flex flex-col gap-4">
      <ol className="list-decimal list-inside space-y-1 text-body-medium-lighter text-[var(--content-default)]">
        <li>Go to <strong>Install App</strong> in the sidebar</li>
        <li>Click <strong>Install to Workspace</strong> and approve the permissions</li>
        <li>Copy the <strong>Bot User OAuth Token</strong> shown on the page</li>
      </ol>
      <p className="text-body-small-default text-[var(--content-faint)]">
        If Slack shows &ldquo;Request approval&rdquo; instead, a workspace admin
        needs to approve the app first.
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
