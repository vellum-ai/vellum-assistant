export const DOCTOR_PORT = 7829;
export const FIREWALL_TAG = "vellum-assistant";
export const GATEWAY_PORT = process.env.GATEWAY_PORT ? Number(process.env.GATEWAY_PORT) : 7830;
export const VALID_REMOTE_HOSTS = ["local", "gcp", "aws", "custom"] as const;
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
      `${ANSI.magenta}    ,___,${ANSI.reset}`,
      `${ANSI.magenta}   (${ANSI.reset}${ANSI.bold} O O ${ANSI.reset}${ANSI.magenta})${ANSI.reset}`,
      `${ANSI.magenta}    /)${ANSI.reset}${ANSI.bold}V${ANSI.reset}${ANSI.magenta}(\\${ANSI.reset}`,
      `${ANSI.magenta}   //   \\\\${ANSI.reset}`,
      `${ANSI.magenta}  /"     "\\${ANSI.reset}`,
      `${ANSI.magenta}  ^       ^${ANSI.reset}`,
    ],
    hatchedEmoji: "🦉",
    waitingMessages: [
      "Warming up the nest...",
      "Getting cozy in there...",
      "Fluffing the feathers...",
      "Preening in the moonlight...",
    ],
    runningMessages: [
      "Running startup script...",
      "Teaching the owlet to code...",
      "Spreading wings...",
      "Almost ready to take flight...",
    ],
  },
};
