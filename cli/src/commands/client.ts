import { existsSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

import {
  findAssistantByName,
  getActiveAssistant,
  resolveAssistant,
  saveAssistantEntry,
} from "../lib/assistant-config";
import {
  DAEMON_INTERNAL_ASSISTANT_ID,
  GATEWAY_PORT,
  type Species,
} from "../lib/constants";
import { loadGuardianToken } from "../lib/guardian-token";
import { getLocalLanIPv4 } from "../lib/local";
import {
  CLI_INTERFACE_ID,
  WEB_INTERFACE_ID,
  getClientRegistrationHeaders,
} from "../lib/client-identity";
import {
  fetchOrganizationId,
  fetchPlatformAssistants,
  readPlatformToken,
} from "../lib/platform-client";
import { tuiLog } from "../lib/tui-log";

const SUPPORTED_INTERFACES = ["cli", "web"] as const;
type SupportedInterface = (typeof SUPPORTED_INTERFACES)[number];

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

const FALLBACK_RUNTIME_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

interface ParsedArgs {
  runtimeUrl: string;
  assistantId: string;
  assistantName?: string;
  species: Species;
  /** "vellum" for platform-hosted assistants, undefined for local. */
  cloud?: string;
  /** Platform session token (X-Session-Token), set when cloud === "vellum". */
  platformToken?: string;
  /** Guardian JWT (Authorization: Bearer), set for local assistants. */
  bearerToken?: string;
  /** Interface identifier sent as X-Vellum-Interface-Id on all requests. */
  interfaceId: SupportedInterface;
  project?: string;
  zone?: string;
}

function readAssistantName(
  entry: ReturnType<typeof findAssistantByName>,
): string | undefined {
  const rawName = entry?.name ?? entry?.assistantName;
  return typeof rawName === "string" && rawName.trim()
    ? rawName.trim()
    : undefined;
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
        arg === "-a" ||
        arg === "--interface" ||
        arg === "-i") &&
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
      // URL provided but active assistant missing or unset — resolve for remaining defaults
      entry = resolveAssistant();
    } else if (!entry) {
      console.error(
        "No active assistant set. Set one with 'vellum use <name>' or specify a name: 'vellum client <name>'.",
      );
      process.exit(1);
    }
  }

  let runtimeUrl = entry?.localUrl || entry?.runtimeUrl || FALLBACK_RUNTIME_URL;
  let assistantId = entry?.assistantId || DAEMON_INTERNAL_ASSISTANT_ID;
  let assistantName = readAssistantName(entry);
  const cloud = entry?.cloud;
  const species: Species = (entry?.species as Species) ?? "vellum";

  // Platform-hosted assistants use a session token; local assistants use a guardian JWT.
  const platformToken =
    cloud === "vellum" ? (readPlatformToken() ?? undefined) : undefined;
  const bearerToken =
    cloud === "vellum"
      ? undefined
      : (loadGuardianToken(entry?.assistantId ?? "")?.accessToken ?? undefined);

  let interfaceId: SupportedInterface = CLI_INTERFACE_ID;

  for (let i = 0; i < flagArgs.length; i++) {
    const flag = flagArgs[i];
    if ((flag === "--url" || flag === "-u") && flagArgs[i + 1]) {
      runtimeUrl = flagArgs[++i];
    } else if (
      (flag === "--assistant-id" || flag === "-a") &&
      flagArgs[i + 1]
    ) {
      assistantId = flagArgs[++i];
      assistantName = undefined;
    } else if ((flag === "--interface" || flag === "-i") && flagArgs[i + 1]) {
      const value = flagArgs[++i];
      if (!(SUPPORTED_INTERFACES as readonly string[]).includes(value)) {
        console.error(
          `Unknown interface '${value}'. Supported: ${SUPPORTED_INTERFACES.join(", ")}.`,
        );
        process.exit(1);
      }
      interfaceId = value as SupportedInterface;
    }
  }

  return {
    runtimeUrl: maybeSwapToLocalhost(runtimeUrl.replace(/\/+$/, "")),
    assistantId,
    assistantName,
    species,
    cloud,
    platformToken,
    bearerToken,
    interfaceId,
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
    -i, --interface <id>       Interface identifier: cli (default) or web
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

async function maybeHydratePlatformAssistantName(
  assistantId: string,
  assistantName: string | undefined,
  cloud: string | undefined,
  platformToken: string | undefined,
): Promise<string | undefined> {
  if (cloud !== "vellum" || assistantName || !platformToken) {
    return assistantName;
  }

  try {
    const matchedAssistant = (
      await fetchPlatformAssistants(platformToken)
    ).find((assistant) => assistant.id === assistantId);
    const hydratedName = matchedAssistant?.name.trim();
    if (!hydratedName) {
      return assistantName;
    }

    const entry = findAssistantByName(assistantId);
    if (entry && entry.name !== hydratedName) {
      saveAssistantEntry({
        ...entry,
        name: hydratedName,
      });
    }

    return hydratedName;
  } catch {
    return assistantName;
  }
}

/**
 * Walk up from this file's location to find a sibling `clients/web` package.
 *
 * Returns the absolute path to its directory, or null when not found —
 * e.g. when the CLI is installed via npm/bunx, where the `clients/web`
 * source isn't shipped alongside `@vellumai/cli`. For now we treat the
 * `--interface web` path as source-checkout-only.
 */
function findClientsWebDir(): string | null {
  let dir = import.meta.dir;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(dir, "clients", "web", "package.json");
    if (existsSync(candidate)) {
      return path.dirname(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Spawn the `clients/web` package's `local` script and proxy its lifecycle.
 *
 * The web client is deliberately not declared as a dependency of `@vellumai/cli`:
 * the CLI is published, the web package is not. Locating it on disk and
 * shelling out keeps the two packages independent.
 */
async function runWebInterface(): Promise<void> {
  const webDir = findClientsWebDir();
  if (!webDir) {
    console.error(
      `${ANSI.bold}--interface web${ANSI.reset}: unable to locate ` +
        `clients/web. This interface currently requires running ` +
        `vellum from a source checkout of vellum-assistant.`,
    );
    process.exit(1);
  }

  const child = Bun.spawn({
    cmd: ["bun", "run", "local"],
    cwd: webDir,
    stdio: ["inherit", "inherit", "inherit"],
  });

  const forward = (signal: "SIGINT" | "SIGTERM"): void => {
    try {
      child.kill(signal);
    } catch {
      // Child already exited; nothing to forward.
    }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));

  const exitCode = await child.exited;
  process.exit(typeof exitCode === "number" ? exitCode : 0);
}

export async function client(): Promise<void> {
  const {
    runtimeUrl,
    assistantId,
    assistantName: parsedAssistantName,
    species,
    cloud,
    platformToken,
    bearerToken,
    interfaceId,
    project,
    zone,
  } = parseArgs();

  if (interfaceId === WEB_INTERFACE_ID) {
    await runWebInterface();
    return;
  }

  tuiLog.init();
  tuiLog.info("session start", {
    runtimeUrl,
    assistantId,
    species,
    cloud,
    interfaceId,
  });

  const assistantName = await maybeHydratePlatformAssistantName(
    assistantId,
    parsedAssistantName,
    cloud,
    platformToken,
  );

  // Build pre-constructed request headers merged from auth + client registration.
  // Spreading into every fetch site ensures consistency across REST and SSE endpoints.
  let auth: Record<string, string> | undefined;
  if (cloud === "vellum" && platformToken) {
    const orgId = await fetchOrganizationId(platformToken).catch((err) => {
      tuiLog.warn("failed to fetch organization id", { err: String(err) });
      return undefined;
    });
    auth = {
      "X-Session-Token": platformToken,
      ...(orgId ? { "Vellum-Organization-Id": orgId } : {}),
      ...getClientRegistrationHeaders(interfaceId),
    };
  } else {
    auth = {
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      ...getClientRegistrationHeaders(interfaceId),
    };
  }

  const { renderChatApp } = await import("../components/DefaultMainScreen");

  process.stdout.write("\x1b[2J\x1b[H");

  const app = renderChatApp(
    runtimeUrl,
    assistantId,
    species,
    () => {
      tuiLog.info("session end (user disconnect)");
      tuiLog.close();
      app.unmount();
      process.stdout.write("\x1b[2J\x1b[H");
      console.log(`${ANSI.dim}Disconnected.${ANSI.reset}`);
      process.exit(0);
    },
    { auth, project, zone, assistantName },
  );
}
