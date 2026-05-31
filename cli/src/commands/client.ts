import { existsSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

import {
  findAssistantByName,
  formatAssistantLookupError,
  getActiveAssistant,
  lookupAssistantByIdentifier,
  resolveAssistant,
  saveAssistantEntry,
  type AssistantEntry,
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
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
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
}

function readAssistantName(entry: AssistantEntry | null): string | undefined {
  const rawName = entry?.name ?? entry?.assistantName;
  return typeof rawName === "string" && rawName.trim()
    ? rawName.trim()
    : undefined;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(3);

  const positionalName = parseAssistantTargetArg(args, [
    "--url",
    "-u",
    "--assistant-id",
    "-a",
    "--interface",
    "-i",
  ]);
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
    }
  }

  let entry: AssistantEntry | null = null;
  if (positionalName) {
    const result = lookupAssistantByIdentifier(positionalName);
    if (result.status !== "found") {
      console.error(formatAssistantLookupError(positionalName, result));
      process.exit(1);
    }
    entry = result.entry;
  } else {
    const hasExplicitUrl =
      flagArgs.includes("--url") || flagArgs.includes("-u");
    const active = getActiveAssistant();
    if (active) {
      const result = lookupAssistantByIdentifier(active);
      if (result.status === "found") {
        entry = result.entry;
      }
      if (!entry && !hasExplicitUrl) {
        console.error(
          `Active assistant '${active}' not found in lockfile. Set an active assistant with 'vellum use <name-or-id>'.`,
        );
        process.exit(1);
      }
    }
    if (!entry && hasExplicitUrl) {
      // URL provided but active assistant missing or unset — resolve for remaining defaults
      entry = resolveAssistant();
    } else if (!entry) {
      console.error(
        "No active assistant set. Set one with 'vellum use <name-or-id>' or specify one: 'vellum client <name-or-id>'.",
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
    vellum client [name-or-id] [options]

${ANSI.bold}ARGUMENTS:${ANSI.reset}
    [name-or-id]               Assistant display name or ID (default: active)

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

const SPA_BASE = "/assistant/";

/**
 * Locate the pre-built @vellumai/web dist directory.
 *
 * Resolution order:
 *   1. npm-installed package — require.resolve('@vellumai/web/package.json')
 *   2. Source checkout — walk up from cli/ to find apps/web/dist/
 */
function findWebDistDir(): string | null {
  try {
    const pkgPath = require.resolve("@vellumai/web/package.json");
    const distDir = path.join(path.dirname(pkgPath), "dist");
    if (existsSync(path.join(distDir, "index.html"))) {
      return distDir;
    }
  } catch {
    // Package not installed; try source checkout.
  }

  let dir = import.meta.dir;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(dir, "apps", "web", "dist", "index.html");
    if (existsSync(candidate)) {
      return path.dirname(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function runWebInterface(): Promise<void> {
  const distDir = findWebDistDir();
  if (!distDir) {
    console.error(
      `${ANSI.bold}--interface web${ANSI.reset}: unable to locate ` +
        `@vellumai/web assets.\n\n` +
        `  npm/bunx install:   npm install @vellumai/web\n` +
        `  source checkout:    cd apps/web && VITE_PLATFORM_MODE=false bun run build`,
    );
    process.exit(1);
  }

  const indexHtml = await Bun.file(path.join(distDir, "index.html")).text();

  const server = Bun.serve({
    port: 3000,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/") {
        return Response.redirect(SPA_BASE, 302);
      }

      if (pathname.startsWith(SPA_BASE)) {
        const relPath = pathname.slice(SPA_BASE.length);
        if (relPath) {
          const filePath = path.join(distDir, relPath);
          const file = Bun.file(filePath);
          if (await file.exists()) {
            return new Response(file);
          }
        }
        return new Response(indexHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(
    `Vellum web interface: http://${server.hostname}:${server.port}${SPA_BASE}`,
  );

  const shutdown = (): void => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
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
    { auth, assistantName },
  );
}
