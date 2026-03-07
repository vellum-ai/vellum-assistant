import type { Command } from "commander";

import { DEFAULT_ELEVENLABS_VOICE_ID } from "../../config/elevenlabs-schema.js";
import { loadRawConfig } from "../../config/loader.js";
import { asRecord, runRead } from "./utils.js";

function readVoiceConfig(): {
  success: true;
  callsEnabled: boolean;
  voiceId: string;
  configuredVoiceId?: string;
  usesDefaultVoice: boolean;
} {
  const raw = loadRawConfig();
  const calls = asRecord(raw.calls);
  const elevenlabs = asRecord(raw.elevenlabs);
  const configuredVoiceId =
    typeof elevenlabs.voiceId === "string" ? elevenlabs.voiceId.trim() : "";

  return {
    success: true,
    callsEnabled: calls.enabled === true,
    voiceId: configuredVoiceId || DEFAULT_ELEVENLABS_VOICE_ID,
    configuredVoiceId: configuredVoiceId || undefined,
    usesDefaultVoice: configuredVoiceId.length === 0,
  };
}

export function registerVoiceSubcommand(integrations: Command): void {
  const voice = integrations.command("voice").description("Voice setup status");

  voice.addHelpText(
    "after",
    `
Shows voice and call readiness configuration. Reads from the local config
file and does not require the gateway to be running.

Examples:
  $ assistant integrations voice config`,
  );

  voice
    .command("config")
    .description("Get voice and call readiness config")
    .addHelpText(
      "after",
      `
Shows voice and call readiness status. Reads from the local config file and
does not require the gateway to be running.

The response includes whether calls are enabled, the active ElevenLabs voice
ID (falls back to default if not configured), whether a custom voice ID is
set, and whether the default voice is in use.

Examples:
  $ assistant integrations voice config
  $ assistant integrations voice config --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () => readVoiceConfig());
    });
}
