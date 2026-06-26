import { ExternalLink } from "lucide-react";
import { useCallback, useState } from "react";

import { Button, Input, Notice, Stepper, type StepperStep } from "@vellumai/design-library";

const WIZARD_STEP_IDS = ["create-app", "app-token", "bot-token"] as const;
type WizardStepId = (typeof WIZARD_STEP_IDS)[number];

const WIZARD_STEPS: StepperStep[] = [
  { id: "create-app", label: "1. Create App" },
  { id: "app-token", label: "2. App Token" },
  { id: "bot-token", label: "3. Bot Token" },
];

export interface SlackSetupWizardProps {
  assistantName: string;
  initialStepId?: WizardStepId;
  onSave?: (botToken: string, appToken: string) => Promise<void>;
}

const SLACK_MANIFEST_SCOPES = {
  bot: [
    "app_mentions:read",
    "assistant:write",
    "channels:history",
    "channels:join",
    "channels:read",
    "chat:write",
    "files:read",
    "files:write",
    "groups:history",
    "groups:read",
    "im:history",
    "im:read",
    "im:write",
    "mpim:history",
    "mpim:read",
    "reactions:read",
    "reactions:write",
    "users:read",
  ],
  user: [
    "channels:history",
    "channels:read",
    "groups:history",
    "groups:read",
    "im:history",
    "im:read",
    "mpim:history",
    "mpim:read",
    "users:read",
    "search:read",
    "reactions:read",
  ],
} as const;

function buildSlackManifestUrl(name: string, description: string): string {
  const manifest = {
    display_information: {
      name,
      ...(description ? { description } : {}),
      background_color: "#1a1a2e",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: name, always_online: true },
      assistant_view: {
        assistant_description: description || name,
        suggested_prompts: [],
      },
    },
    oauth_config: { scopes: SLACK_MANIFEST_SCOPES },
    settings: {
      event_subscriptions: {
        bot_events: [
          "app_mention",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
          "reaction_added",
        ],
      },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };

  return (
    "https://api.slack.com/apps?new_app=1&manifest_json=" +
    encodeURIComponent(JSON.stringify(manifest))
  );
}

export function SlackSetupWizard({
  assistantName,
  initialStepId = "create-app",
  onSave,
}: SlackSetupWizardProps) {
  const [stepId, setStepId] = useState<WizardStepId>(initialStepId);
  const [botName, setBotName] = useState(assistantName);
  const [botDescription, setBotDescription] = useState("");
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appCreated, setAppCreated] = useState(false);

  const stepIndex = WIZARD_STEP_IDS.indexOf(stepId);

  const handleCreateApp = useCallback(() => {
    const url = buildSlackManifestUrl(
      botName.trim() || assistantName,
      botDescription.trim(),
    );
    window.open(url, "_blank", "noopener,noreferrer");
    setAppCreated(true);
  }, [botName, assistantName, botDescription]);

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

  return (
    <div className="flex flex-col gap-4 pl-7" data-slot="slack-setup-wizard">
      <Stepper
        steps={WIZARD_STEPS}
        current={stepIndex}
        onStepSelect={handleStepSelect}
        disabled={saving}
      />

      {stepId === "create-app" && (
        <CreateAppStep
          botName={botName}
          botDescription={botDescription}
          appCreated={appCreated}
          onBotNameChange={setBotName}
          onBotDescriptionChange={setBotDescription}
          onCreateApp={handleCreateApp}
          onNext={() => setStepId("app-token")}
        />
      )}

      {stepId === "app-token" && (
        <AppTokenStep
          appToken={appToken}
          onAppTokenChange={setAppToken}
          onNext={() => setStepId("bot-token")}
        />
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
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Create Slack App
// ---------------------------------------------------------------------------

interface CreateAppStepProps {
  botName: string;
  botDescription: string;
  appCreated: boolean;
  onBotNameChange: (value: string) => void;
  onBotDescriptionChange: (value: string) => void;
  onCreateApp: () => void;
  onNext: () => void;
}

function CreateAppStep({
  botName,
  botDescription,
  appCreated,
  onBotNameChange,
  onBotDescriptionChange,
  onCreateApp,
  onNext,
}: CreateAppStepProps) {
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="info">
        Name your bot, then click the button below. Slack will open with
        everything pre-configured — just pick your workspace and click{" "}
        <strong>Create</strong>.
      </Notice>
      <Input
        label="Bot Name"
        type="text"
        value={botName}
        onChange={(e) => onBotNameChange(e.target.value)}
        placeholder="My Assistant"
        fullWidth
      />
      <Input
        label="Description (optional)"
        type="text"
        value={botDescription}
        onChange={(e) => onBotDescriptionChange(e.target.value)}
        placeholder="A brief description of your bot"
        fullWidth
      />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={onCreateApp}
          disabled={!botName.trim()}
          leftIcon={<ExternalLink aria-hidden />}
        >
          Create Slack App
        </Button>
        {appCreated ? (
          <Button type="button" variant="outlined" onClick={onNext}>
            Next
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — App-Level Token
// ---------------------------------------------------------------------------

interface AppTokenStepProps {
  appToken: string;
  onAppTokenChange: (value: string) => void;
  onNext?: () => void;
}

function AppTokenStep({
  appToken,
  onAppTokenChange,
  onNext,
}: AppTokenStepProps) {
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="info" title="In your Slack app settings:">
        <ol className="mt-1 ml-4 list-decimal space-y-1">
          <li>
            Go to <strong>Basic Information</strong>
          </li>
          <li>
            Scroll to <strong>App-Level Tokens</strong>
          </li>
          <li>
            Click <strong>Generate Token and Scopes</strong>
          </li>
          <li>Name it anything (e.g. &quot;Socket Mode&quot;)</li>
          <li>
            Add scope:{" "}
            <code className="rounded bg-[var(--surface-sunken)] px-1 py-0.5">
              connections:write
            </code>
          </li>
          <li>
            Click <strong>Generate</strong> and copy the token
          </li>
        </ol>
      </Notice>
      <Input
        label="App-Level Token"
        type="password"
        value={appToken}
        onChange={(e) => onAppTokenChange(e.target.value)}
        placeholder="xapp-..."
        fullWidth
      />
      <div>
        <Button
          type="button"
          onClick={onNext}
          disabled={!appToken.trim()}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Bot Token
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
    <div className="flex flex-col gap-3">
      <Notice tone="info" title="Install your Slack app:">
        <ol className="mt-1 ml-4 list-decimal space-y-1">
          <li>
            Go to <strong>Install App</strong> in the sidebar
          </li>
          <li>
            Click <strong>Install to Workspace</strong>
          </li>
          <li>Authorize the requested permissions</li>
          <li>
            Copy the <strong>Bot User OAuth Token</strong>
          </li>
        </ol>
      </Notice>
      <Input
        label="Bot User OAuth Token"
        type="password"
        value={botToken}
        onChange={(e) => onBotTokenChange(e.target.value)}
        placeholder="xoxb-..."
        fullWidth
      />
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : null}
      <div>
        <Button
          type="button"
          onClick={onSave}
          disabled={!botToken.trim() || saving}
        >
          {saving ? "Saving\u2026" : "Save"}
        </Button>
      </div>
    </div>
  );
}
