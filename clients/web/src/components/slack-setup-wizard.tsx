import { Check, ClipboardCopy, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button, Input, Notice, Typography } from "@vellumai/design-library";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import {
  buildSlackManifest,
  SLACK_MANIFEST_BOT_SCOPES,
} from "@/utils/slack-manifest";
import {
  probeSlackScopes,
  type SlackScopeProbeResult,
} from "@/utils/slack-scope-probe";

export type MutationStatus = "idle" | "pending" | "success" | "error";

/**
 * Slack's create-app entry point. Deliberately carries no `manifest_json`
 * payload: Slack's modal intercepts this URL and ignores the parameter, so
 * the manifest travels via the clipboard instead.
 */
const SLACK_NEW_APP_URL = "https://api.slack.com/apps?new_app=1";

const BOT_TOKEN_PREFIX = "xoxb-";
const APP_TOKEN_PREFIX = "xapp-";

/**
 * Shortest plausible Slack token. Real tokens run far longer; this only needs
 * to catch a truncated paste, not to validate the credential.
 */
const TOKEN_MIN_LENGTH = 20;

/**
 * Format-check a pasted Slack token. Returns an error string, or null when the
 * value is acceptable *or* still empty — an untouched field is not an error.
 */
export function validateSlackToken(
  value: string,
  prefix: string,
  label: string,
): string | null {
  const token = value.trim();
  if (!token) {return null;}
  if (!token.startsWith(prefix)) {
    return `${label} should start with "${prefix}".`;
  }
  if (token.length < TOKEN_MIN_LENGTH) {
    return `${label} looks truncated — copy the whole value from Slack.`;
  }
  return null;
}

export interface SlackSetupWizardProps {
  assistantName: string;
  onSave?: (botToken: string, appToken: string) => void;
  saveStatus?: MutationStatus;
  saveError?: string | null;
  /**
   * Post-save scope check. Injectable so stories and tests can exercise the
   * drift path without touching the live Slack API.
   */
  probeScopes?: (botToken: string) => Promise<SlackScopeProbeResult>;
}

/**
 * Single-step guided setup for connecting a Slack app.
 *
 * Slack's new create-app modal ignores manifest deep links and mints both the
 * bot and app-level tokens itself on Create + Install, so the flow is: copy the
 * manifest, paste it into the modal's "From a manifest" tile, then bring both
 * tokens back here. Settings for an already-connected Slack (thread behavior)
 * live in `SlackThreadBehavior`.
 */
export function SlackSetupWizard({
  assistantName,
  onSave,
  saveStatus = "idle",
  saveError = null,
  probeScopes = probeSlackScopes,
}: SlackSetupWizardProps) {
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

  const { copy, copied } = useCopyToClipboard();

  const manifestJson = useMemo(
    () => JSON.stringify(buildSlackManifest(slackAppName, description), null, 2),
    [slackAppName, description],
  );

  const nameValid = slackAppName.trim().length > 0;

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

  const handleCopyManifest = useCallback(() => {
    copy(manifestJson);
  }, [copy, manifestJson]);

  const handleOpenSlack = useCallback(() => {
    window.open(SLACK_NEW_APP_URL, "_blank", "noopener,noreferrer");
  }, []);

  const handleSave = useCallback(() => {
    if (!canSave) {return;}
    onSave?.(botToken.trim(), appToken.trim());
  }, [canSave, onSave, botToken, appToken]);

  const [scopeProbe, setScopeProbe] = useState<SlackScopeProbeResult | null>(
    null,
  );
  const probedToken = useRef<string | null>(null);

  // Slack's install flow can return a healthy-looking token carrying only a
  // fraction of the requested scopes. Check once the credentials land, so the
  // user fixes it with one reinstall instead of hitting dead features later.
  // probeSlackScopes never rejects, so there's nothing to catch.
  useEffect(() => {
    if (saveStatus !== "success") {return;}
    const token = botToken.trim();
    if (!token || probedToken.current === token) {return;}
    probedToken.current = token;

    let cancelled = false;
    let settled = false;
    void probeScopes(token).then((result) => {
      settled = true;
      if (!cancelled) {setScopeProbe(result);}
    });
    return () => {
      cancelled = true;
      // Release the guard when this run delivered no result, so the next run
      // probes again instead of honoring a reservation nothing fulfilled.
      // Without this, any teardown between reserving the token and resolving
      // (a remount, an effect re-run) permanently suppresses the drift card.
      if (!settled && probedToken.current === token) {
        probedToken.current = null;
      }
    };
  }, [saveStatus, botToken, probeScopes]);

  return (
    <div data-slot="slack-setup-wizard">
      <div className="flex flex-col gap-5 rounded-lg bg-[var(--surface-sunken)] p-4">
        <div className="flex flex-col gap-4">
          <Typography
            as="p"
            variant="body-medium-lighter"
            className="text-[color:var(--content-default)]"
          >
            Name your Slack app, copy its manifest, then create it in Slack. All
            permissions and settings come pre-configured.
          </Typography>

          <Input
            label="App Name"
            value={slackAppName}
            onChange={(e) => {
              userEditedName.current = true;
              setSlackAppName(e.target.value.slice(0, 35));
            }}
            placeholder="My Assistant"
            fullWidth
          />

          <Input
            label="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 140))}
            placeholder="What this assistant helps with"
            helperText="Shown on the app's Slack profile."
            fullWidth
          />
        </div>

        <div className="flex flex-col gap-3">
          <Typography
            as="p"
            variant="body-medium-lighter"
            className="text-[color:var(--content-default)]"
          >
            In Slack:
          </Typography>
          <ol className="list-decimal list-inside space-y-1 text-body-medium-lighter text-[var(--content-default)]">
            <li>
              Pick the <strong>From a manifest</strong> tile in the{" "}
              <strong>Create an app</strong> dialog
            </li>
            <li>Choose your workspace, then paste the manifest you copied</li>
            <li>
              Click <strong>Create</strong>, then <strong>Install</strong> and
              approve the permissions
            </li>
            <li>
              Copy both tokens Slack shows you when the install finishes
            </li>
          </ol>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outlined"
              disabled={!nameValid}
              onClick={handleCopyManifest}
              leftIcon={
                copied ? (
                  <Check aria-hidden className="size-4" />
                ) : (
                  <ClipboardCopy aria-hidden className="size-4" />
                )
              }
            >
              {copied ? "Copied!" : "Copy manifest JSON"}
            </Button>
            <Button
              type="button"
              disabled={!nameValid}
              onClick={handleOpenSlack}
              rightIcon={<ExternalLink aria-hidden className="size-4" />}
            >
              Open Slack
            </Button>
          </div>

          <Typography
            as="p"
            variant="body-small-default"
            className="text-[color:var(--content-faint)]"
          >
            If Slack shows &ldquo;Request approval&rdquo; instead of{" "}
            <strong>Install</strong>, a workspace admin needs to approve the app
            first.
          </Typography>
        </div>

        <div className="flex flex-col gap-3">
          <Typography
            as="p"
            variant="body-medium-lighter"
            className="text-[color:var(--content-default)]"
          >
            Paste both tokens from Slack&apos;s install screen:
          </Typography>

          <Input
            label="Bot Token"
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={`${BOT_TOKEN_PREFIX}...`}
            errorText={botTokenError ?? undefined}
            fullWidth
          />

          <Input
            label="App Token"
            type="password"
            value={appToken}
            onChange={(e) => setAppToken(e.target.value)}
            placeholder={`${APP_TOKEN_PREFIX}...`}
            errorText={appTokenError ?? undefined}
            fullWidth
          />

          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="primary"
              onClick={handleSave}
              disabled={!canSave}
            >
              {saveStatus === "pending" ? "Connecting…" : "Connect Slack"}
            </Button>
          </div>

          {saveStatus === "success" && (
            <>
              <Typography
                as="p"
                variant="body-small-default"
                className="text-[color:var(--content-positive)]"
              >
                Credentials saved.
              </Typography>

              {/* Only a missing mandatory scope is worth interrupting for.
                  Optional ones were declined on Slack's consent screen, and
                  reinstalling would replay that screen to the same answer. */}
              {scopeProbe?.status === "incomplete" && (
                <Notice
                  tone="warning"
                  title="Slack didn&rsquo;t grant every permission we asked for"
                  actions={
                    <Button
                      type="button"
                      variant="outlined"
                      size="compact"
                      onClick={() =>
                        window.open(
                          scopeProbe.reinstallUrl,
                          "_blank",
                          "noopener,noreferrer",
                        )
                      }
                      rightIcon={<ExternalLink aria-hidden className="size-4" />}
                    >
                      Reinstall in Slack
                    </Button>
                  }
                >
                  <Typography as="p" variant="body-small-default">
                    {scopeProbe.missingRequiredScopes.length} of{" "}
                    {SLACK_MANIFEST_BOT_SCOPES.length} permissions are missing,
                    so some features won&apos;t work. Reinstalling grants them
                    to this same token — you won&apos;t need new ones.
                  </Typography>
                  <Typography
                    as="p"
                    variant="body-small-default"
                    className="mt-2 font-mono text-[color:var(--content-faint)]"
                  >
                    Missing: {scopeProbe.missingRequiredScopes.join(", ")}
                  </Typography>
                </Notice>
              )}

              {scopeProbe?.status === "degraded" && (
                <Typography
                  as="p"
                  variant="body-small-default"
                  className="text-[color:var(--content-faint)]"
                >
                  Optional permissions you declined stay off:{" "}
                  <span className="font-mono">
                    {scopeProbe.missingScopes.join(", ")}
                  </span>
                  . Everything else is connected — grant them later from the
                  app&apos;s settings in Slack if you change your mind.
                </Typography>
              )}
            </>
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
      </div>
    </div>
  );
}
