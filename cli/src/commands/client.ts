import { hostname } from "os";

import {
  findAssistantByName,
  getActiveAssistant,
  loadLatestAssistant,
} from "../lib/assistant-config";
import { DAEMON_INTERNAL_ASSISTANT_ID, GATEWAY_PORT, type Species } from "../lib/constants";
import { loadGuardianToken } from "../lib/guardian-token";
import { getLocalLanIPv4, getMacLocalHostname } from "../lib/local";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

const FALLBACK_RUNTIME_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

interface ParsedArgs {
  runtimeUrl: string;
  assistantId: string;
  species: Species;
  bearerToken?: string;
  project?: string;
  zone?: string;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(3);

  let positionalName: string | undefined;
  const flagArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (
      (arg === "--url" ||
        arg === "-u" ||
        arg === "--assistant-id" ||
        arg === "-a") &&
      args[i + 1]
    ) {
      flagArgs.push(arg, args[++i]);
    } else if (!arg.startsWith("-") && positionalName === undefined) {
      positionalName = arg;
    }
  }

  let entry: ReturnType<typeof findAssistantByName> = null;
  if (positionalName) {
    entry = findAssistantByName(positionalName);
    if (!entry) {
      console.error(
        `No assistant instance found with name '${positionalName}'.`,
      );
      process.exit(1);
    }
  } else {
    const hasExplicitUrl =
      flagArgs.includes("--url") || flagArgs.includes("-u");
    const active = getActiveAssistant();
    if (active) {
      entry = findAssistantByName(active);
      if (!entry && !hasExplicitUrl) {
        console.error(
          `Active assistant '${active}' not found in lockfile. Set an active assistant with 'vellum use <name>'.`,
        );
        process.exit(1);
      }
    }
    if (!entry && hasExplicitUrl) {
      // URL provided but active assistant missing or unset — use latest for remaining defaults
      entry = loadLatestAssistant();
    } else if (!entry) {
      console.error(
        "No active assistant set. Set one with 'vellum use <name>' or specify a name: 'vellum client <name>'.",
      );
      process.exit(1);
    }
  }

  let runtimeUrl = entry?.localUrl || entry?.runtimeUrl || FALLBACK_RUNTIME_URL;
  let assistantId = entry?.assistantId || DAEMON_INTERNAL_ASSISTANT_ID;
  const bearerToken = loadGuardianToken(entry?.assistantId ?? "")?.accessToken ?? undefined;
  const species: Species = (entry?.species as Species) ?? "vellum";

  for (let i = 0; i < flagArgs.length; i++) {
    const flag = flagArgs[i];
    if ((flag === "--url" || flag === "-u") && flagArgs[i + 1]) {
      runtimeUrl = flagArgs[++i];
    } else if (
      (flag === "--assistant-id" || flag === "-a") &&
      flagArgs[i + 1]
    ) {
      assistantId = flagArgs[++i];
    }
  }

  return {
    runtimeUrl: maybeSwapToLocalhost(runtimeUrl.replace(/\/+$/, "")),
    assistantId,
    species,
    bearerToken,
    project: entry?.project,
    zone: entry?.zone,
  };
}

/**
 * If the hostname in `url` matches this machine's local DNS name, LAN IP, or
 * raw hostname, replace it with 127.0.0.1 so the client avoids mDNS round-trips
 * when talking to an assistant running on the same machine.
 */
function maybeSwapToLocalhost(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const urlHost = parsed.hostname.toLowerCase();

  const localNames: string[] = [];

  const host = hostname();
  if (host) {
    localNames.push(host.toLowerCase());
    // Also consider the bare name without .local suffix
    if (host.toLowerCase().endsWith(".local")) {
      localNames.push(host.toLowerCase().slice(0, -".local".length));
    }
  }

  const macHost = getMacLocalHostname();
  if (macHost) {
    localNames.push(macHost.toLowerCase());
  }

  const lanIp = getLocalLanIPv4();
  if (lanIp) {
    localNames.push(lanIp);
  }

  if (localNames.includes(urlHost)) {
    parsed.hostname = "127.0.0.1";
    return parsed.toString().replace(/\/+$/, "");
  }

  return url;
}

function printUsage(): void {
  console.log(`${ANSI.bold}vellum client${ANSI.reset} - Connect to a hatched assistant

${ANSI.bold}USAGE:${ANSI.reset}
    vellum client [name] [options]

${ANSI.bold}ARGUMENTS:${ANSI.reset}
    [name]                     Instance name (default: active)

${ANSI.bold}OPTIONS:${ANSI.reset}
    -u, --url <url>            Runtime URL
    -a, --assistant-id <id>    Assistant ID
    -h, --help                 Show this help message

${ANSI.bold}DEFAULTS:${ANSI.reset}
    Reads from ~/.vellum.lock.json (created by vellum hatch).
    Override with flags above.

${ANSI.bold}EXAMPLES:${ANSI.reset}
    vellum client
    vellum client vellum-assistant-foo
    vellum client --url http://34.56.78.90:${GATEWAY_PORT}
    vellum client vellum-assistant-foo --url http://localhost:${GATEWAY_PORT}
`);
}

export async function client(): Promise<void> {
  const { runtimeUrl, assistantId, species, bearerToken, project, zone } =
    parseArgs();

  const { renderChatApp } = await import("../components/DefaultMainScreen");

  process.stdout.write("\x1b[2J\x1b[H");

  const app = renderChatApp(
    runtimeUrl,
    assistantId,
    species,
    () => {
      app.unmount();
      process.stdout.write("\x1b[2J\x1b[H");
      console.log(`${ANSI.dim}Disconnected.${ANSI.reset}`);
      process.exit(0);
    },
    { bearerToken, project, zone },
  );
}
