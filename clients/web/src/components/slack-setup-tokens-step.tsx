import { Button, Input, Notice, Typography } from "@vellumai/design-library";
import type { MutationStatus } from "@/components/channel-setup-wizard";
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  validateSlackToken,
} from "@/utils/slack-token-validation";

export interface SlackSetupTokensStepProps {
  botToken: string;
  appToken: string;
  saveStatus: MutationStatus;
  saveError: string | null;
  onBotTokenChange: (value: string) => void;
  onAppTokenChange: (value: string) => void;
  onSave: () => void;
}

/**
 * Step 4 of `SlackSetupWizard`: bring both tokens back from Slack.
 *
 * Slack mints the `xapp-` app token alongside the `xoxb-` bot token on Create
 * and Install, so both are collected here rather than across separate steps.
 */
export function SlackSetupTokensStep({
  botToken,
  appToken,
  saveStatus,
  saveError,
  onBotTokenChange,
  onAppTokenChange,
  onSave,
}: SlackSetupTokensStepProps) {
  const botTokenError = validateSlackToken(
    botToken,
    BOT_TOKEN_PREFIX,
    "Bot token",
  );
  const appTokenError = validateSlackToken(
    appToken,
    APP_TOKEN_PREFIX,
    "App token",
  );

  const canSave =
    botToken.trim().length > 0 &&
    appToken.trim().length > 0 &&
    !botTokenError &&
    !appTokenError &&
    saveStatus !== "pending";

  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        On Slack&apos;s confirmation screen, expand{" "}
        <strong>Your app credentials</strong> and copy both tokens.
      </Typography>

      <Notice tone="warning">
        That screen also offers a command-line walkthrough and a{" "}
        <strong>Download app files</strong> button. Skip both. They set up a
        separate local app, and this assistant needs only the two tokens.
      </Notice>

      <Input
        label="Bot Token"
        type="password"
        value={botToken}
        onChange={(e) => onBotTokenChange(e.target.value)}
        placeholder={`${BOT_TOKEN_PREFIX}...`}
        errorText={botTokenError ?? undefined}
        disabled={saveStatus === "pending"}
        fullWidth
      />

      <Input
        label="App Token"
        type="password"
        value={appToken}
        onChange={(e) => onAppTokenChange(e.target.value)}
        placeholder={`${APP_TOKEN_PREFIX}...`}
        errorText={appTokenError ?? undefined}
        disabled={saveStatus === "pending"}
        fullWidth
      />

      <Button
        type="button"
        variant="primary"
        className="self-start"
        onClick={onSave}
        disabled={!canSave}
      >
        {saveStatus === "pending" ? "Connecting…" : "Connect Slack"}
      </Button>

      {saveStatus === "success" && (
        <Typography
          as="p"
          variant="body-small-default"
          className="text-[color:var(--content-positive)]"
        >
          Credentials saved.
        </Typography>
      )}
      {saveStatus === "error" && saveError && (
        <Typography
          as="p"
          variant="body-small-default"
          className="text-[color:var(--system-negative-strong)]"
        >
          {saveError}
        </Typography>
      )}
    </div>
  );
}
