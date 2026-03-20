import providerEnvVarsRegistry from "../../../meta/provider-env-vars.json";

/**
 * Canonical internal assistant ID used as the default/fallback across the CLI
 * and daemon. Mirrors `DAEMON_INTERNAL_ASSISTANT_ID` from
 * `assistant/src/runtime/assistant-scope.ts`.
 */
export const DAEMON_INTERNAL_ASSISTANT_ID = "self" as const;

export const FIREWALL_TAG = "vellum-assistant";
export const GATEWAY_PORT = process.env.GATEWAY_PORT
  ? Number(process.env.GATEWAY_PORT)
  : 7830;

/** Default ports used as scan start points for multi-instance allocation. */
export const DEFAULT_DAEMON_PORT = 7821;
export const DEFAULT_GATEWAY_PORT = 7830;
export const DEFAULT_QDRANT_PORT = 6333;
export const DEFAULT_CES_PORT = 8090;

/**
 * Environment variable names for provider API keys, keyed by provider ID.
 * Loaded from the shared registry at `meta/provider-env-vars.json` — the
 * single source of truth also consumed by the assistant runtime and the
 * macOS client.
 */
export const PROVIDER_ENV_VAR_NAMES: Record<string, string> =
  providerEnvVarsRegistry.providers;

export const VALID_REMOTE_HOSTS = [
  "local",
  "gcp",
  "aws",
  "docker",
  "custom",
  "vellum-cloud",
] as const;
export type RemoteHost = (typeof VALID_REMOTE_HOSTS)[number];
export const VALID_SPECIES = ["openclaw", "vellum"] as const;
export type Species = (typeof VALID_SPECIES)[number];

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
} as const;

interface SpeciesConfig {
  color: string;
  art: string[];
  hatchedEmoji: string;
  waitingMessages: string[];
  runningMessages: string[];
}

export const SPECIES_CONFIG: Record<Species, SpeciesConfig> = {
  openclaw: {
    color: ANSI.red,
    art: [
      `${ANSI.red}     ___${ANSI.reset}`,
      `${ANSI.red}    / ${ANSI.reset}${ANSI.bold}o${ANSI.reset}${ANSI.red} \\${ANSI.reset}`,
      `${ANSI.red}   |  ${ANSI.reset}${ANSI.bold}>${ANSI.reset}${ANSI.red}  |${ANSI.reset}`,
      `${ANSI.red}   /|   |\\${ANSI.reset}`,
      `${ANSI.red}  / |___| \\${ANSI.reset}`,
      `${ANSI.red} |  /   \\  |${ANSI.reset}`,
      `${ANSI.red} |_/     \\_|${ANSI.reset}`,
      `${ANSI.red}  V       V${ANSI.reset}`,
      `${ANSI.red}  |_|   |_|${ANSI.reset}`,
    ],
    hatchedEmoji: "🦞",
    waitingMessages: [
      "Warming up the egg...",
      "Getting cozy in there...",
      "Preparing the nest...",
      "Gathering shell fragments...",
    ],
    runningMessages: [
      "Running startup script...",
      "Teaching the hatchling to code...",
      "Growing stronger...",
      "Almost ready to peek out...",
    ],
  },
  vellum: {
    color: ANSI.magenta,
    art: [
      `${ANSI.magenta}   .-.-.-.${ANSI.reset}`,
      `${ANSI.magenta}  |${ANSI.reset}${ANSI.bold} o   o ${ANSI.reset}${ANSI.magenta}|${ANSI.reset}`,
      `${ANSI.magenta}  |${ANSI.reset}${ANSI.bold}  ---  ${ANSI.reset}${ANSI.magenta}|${ANSI.reset}`,
      `${ANSI.magenta}  |_|_|_|_|${ANSI.reset}`,
      `${ANSI.magenta}   | | | |${ANSI.reset}`,
      `${ANSI.magenta}   ^ ^_^ ^${ANSI.reset}`,
    ],
    hatchedEmoji: "👾",
    waitingMessages: [
      "Warming up the mothership...",
      "Getting cozy in there...",
      "Calibrating the antenna...",
      "Scanning the galaxy...",
    ],
    runningMessages: [
      "Running startup script...",
      "Teaching the alien to code...",
      "Powering up...",
      "Almost ready to beam down...",
    ],
  },
};
