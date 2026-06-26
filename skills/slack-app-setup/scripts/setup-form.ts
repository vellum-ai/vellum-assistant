#!/usr/bin/env bun
// Slack app setup, as a single in-chat form.
//
// Replaces the multi-turn token-collection conversation with one
// `assistant ui request` multi-page form. The user creates the app from a
// one-click manifest link, generates an app-level token, installs the app,
// and pastes both tokens — all inside one card. This script then stores the
// tokens through the same validated credential path the Settings UI uses
// (`assistant channels configure-slack`), which checks them against Slack,
// records workspace metadata, and activates Socket Mode.
//
// Usage (JSON on stdin, paired with a quoted heredoc so any character in the
// bot name or description passes through verbatim):
//   echo '{"name":"My Bot","desc":"Assistant for X"}' \
//     | bun run skills/slack-app-setup/scripts/setup-form.ts
//
// Output: a single JSON status object on stdout. It NEVER contains token
// values — the tokens flow from the form straight into the credential store
// without passing through this script's stdout (which the assistant reads).
//
//   { "ok": true,  "status": "configured", "connected": true,
//     "teamName": "...", "botUsername": "...", "warning"?: "..." }
//   { "ok": false, "status": "config_failed", "error": "..." }
//   { "ok": false, "status": "cancelled", "reason": "..." }
//   { "ok": false, "status": "timed_out" }
//   { "ok": false, "status": "error", "error": "..." }

import { buildManifestUrl } from "./build-manifest-url.ts";

type Input = { name?: string; desc?: string };

function emit(result: Record<string, unknown>): never {
  console.log(JSON.stringify(result));
  process.exit(result.ok === true ? 0 : 1);
}

/**
 * Spawn `assistant <args>`, capturing stdout/stderr. On a spawn failure (e.g.
 * the assistant CLI is unavailable) emit a clean status object instead of
 * letting an uncaught error dump a stack trace into the assistant's view.
 */
async function runCaptureOrEmit(
  args: string[],
  stdin: "ignore" | Uint8Array,
  onFail: { status: string; prefix: string },
): Promise<{ stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(args, { stdin, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { stdout, stderr };
  } catch (err) {
    emit({
      ok: false,
      status: onFail.status,
      error: `${onFail.prefix}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ── Read bot identity from stdin ──────────────────────────────────────

let input: Input = {};
const stdinText = await Bun.stdin.text();
if (stdinText.trim()) {
  try {
    input = JSON.parse(stdinText);
  } catch (err) {
    emit({
      ok: false,
      status: "error",
      error: `Invalid JSON on stdin: ${(err as Error).message}`,
    });
  }
}

const name = input.name ?? process.env.BOT_NAME;
const desc = input.desc ?? process.env.BOT_DESC ?? "";
if (!name) {
  emit({
    ok: false,
    status: "error",
    error: 'Missing bot name. Pass {"name":"..."} on stdin or set BOT_NAME.',
  });
}

const manifestUrl = buildManifestUrl(name!, desc);

// ── Build the 3-page form ─────────────────────────────────────────────

const payload = {
  progressStyle: "tabs",
  pages: [
    {
      id: "create-app",
      title: "Create App",
      description:
        "Click the link below to create your Slack app. It's pre-configured " +
        "with all the right permissions, events, and Socket Mode.\n\n" +
        `[Create Slack App](${manifestUrl})\n\n` +
        "Select your workspace and click **Create**. Then continue to the next step.",
      fields: [],
    },
    {
      id: "app-token",
      title: "Generate App Token",
      description:
        "In your new Slack app, go to **Settings → Basic Information → " +
        "App-Level Tokens**:\n" +
        "1. Click **Generate Token and Scopes**\n" +
        '2. Name it "Socket Mode" (or anything)\n' +
        "3. Add scope: `connections:write`\n" +
        "4. Click **Generate**\n" +
        "5. Copy the token and paste it below.",
      fields: [
        {
          id: "app_token",
          type: "password",
          label: "App-Level Token",
          placeholder: "xapp-...",
          required: true,
        },
      ],
    },
    {
      id: "bot-token",
      title: "Install & Get Bot Token",
      description:
        "Go to **Settings → Install App → Install to Workspace**, then " +
        "authorize the requested permissions.\n\n" +
        "After install, the **Bot User OAuth Token** appears on the same " +
        "page. Copy it and paste it below.",
      fields: [
        {
          id: "bot_token",
          type: "password",
          label: "Bot User OAuth Token",
          placeholder: "xoxb-...",
          required: true,
        },
      ],
    },
  ],
  pageLabels: {
    next: "Next",
    back: "Back",
    submit: "Connect",
  },
};

// ── Show the form and await the user ──────────────────────────────────

const { stdout: uiStdout, stderr: uiStderr } = await runCaptureOrEmit(
  [
    "assistant",
    "ui",
    "request",
    "--surface-type",
    "form",
    "--title",
    "Connect Slack",
    "--payload",
    JSON.stringify(payload),
    // Give the user room to create the app, generate a token, and install,
    // while staying under the bash tool's 600s ceiling so this script can
    // still store the tokens and report before the wrapper is killed.
    "--timeout",
    "570000",
    "--json",
  ],
  "ignore",
  { status: "error", prefix: "Could not show the setup form" },
);

let uiResult: {
  ok?: boolean;
  status?: string;
  submittedData?: Record<string, unknown>;
  cancellationReason?: string;
  error?: string;
};
try {
  uiResult = JSON.parse(uiStdout.trim());
} catch {
  emit({
    ok: false,
    status: "error",
    error: `Could not parse the form response: ${uiStderr.trim() || uiStdout.trim() || "no output"}`,
  });
}

if (uiResult!.ok === false) {
  emit({
    ok: false,
    status: "error",
    error: uiResult!.error ?? "The form request failed.",
  });
}

if (uiResult!.status === "timed_out") {
  emit({ ok: false, status: "timed_out" });
}

if (uiResult!.status === "cancelled") {
  emit({
    ok: false,
    status: "cancelled",
    reason: uiResult!.cancellationReason ?? "user_dismissed",
  });
}

if (uiResult!.status !== "submitted") {
  emit({
    ok: false,
    status: "error",
    error: `Unexpected form status: ${uiResult!.status ?? "unknown"}`,
  });
}

// ── Extract tokens (kept in-process; never printed) ───────────────────

const submitted = uiResult!.submittedData ?? {};
const appToken =
  typeof submitted.app_token === "string" ? submitted.app_token.trim() : "";
const botToken =
  typeof submitted.bot_token === "string" ? submitted.bot_token.trim() : "";

if (!appToken || !botToken) {
  emit({
    ok: false,
    status: "config_failed",
    error: "The form did not return both tokens. Re-run setup and try again.",
  });
}

// ── Store tokens through the validated credential path ─────────────────
// Tokens go to the child's stdin (not argv) so they never appear in a
// process listing. `configure-slack` validates them, records workspace
// metadata, and activates Socket Mode.

const { stdout: cfgStdout, stderr: cfgStderr } = await runCaptureOrEmit(
  ["assistant", "channels", "configure-slack", "--json"],
  Buffer.from(JSON.stringify({ botToken, appToken })),
  { status: "config_failed", prefix: "Could not store the tokens" },
);

let cfgResult: {
  ok?: boolean;
  connected?: boolean;
  teamName?: string;
  botUsername?: string;
  warning?: string;
  error?: string;
};
try {
  cfgResult = JSON.parse(cfgStdout.trim());
} catch {
  emit({
    ok: false,
    status: "config_failed",
    error: `Could not store the tokens: ${cfgStderr.trim() || "no output"}`,
  });
}

if (cfgResult!.ok === false || cfgResult!.error) {
  emit({
    ok: false,
    status: "config_failed",
    error: cfgResult!.error ?? "Failed to store Slack tokens.",
  });
}

emit({
  ok: true,
  status: "configured",
  connected: cfgResult!.connected ?? false,
  ...(cfgResult!.teamName ? { teamName: cfgResult!.teamName } : {}),
  ...(cfgResult!.botUsername ? { botUsername: cfgResult!.botUsername } : {}),
  ...(cfgResult!.warning ? { warning: cfgResult!.warning } : {}),
});
