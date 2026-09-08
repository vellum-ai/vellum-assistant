// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../package.json";

import {
  saveAssistantEntry,
  setActiveAssistant,
} from "../lib/assistant-config";
import {
  SPECIES_CONFIG,
  VALID_REMOTE_HOSTS,
  VALID_SPECIES,
} from "../lib/constants";
import type { RemoteHost, Species } from "../lib/constants";
import { hatchDocker } from "../lib/docker";
import { parseFeatureFlagArgs, readAmbientFlagEnvVars } from "../lib/flag-args";
import { hatchLocal } from "../lib/hatch-local";
import {
  getPlatformUrl,
  hatchAssistant,
  readPlatformToken,
} from "../lib/platform-client";
import { validateAssistantName } from "../lib/retire-archive";

const DEFAULT_SPECIES: Species = "vellum";

const DEFAULT_REMOTE: RemoteHost = "local";

interface HatchArgs {
  species: Species;
  detached: boolean;
  keepAlive: boolean;
  name: string | null;
  remote: RemoteHost;
  watch: boolean;
  sourcePath: string | null;
  preview: boolean;
  configValues: Record<string, string>;
  flagEnvVars: Record<string, string>;
  analyze: boolean;
  disablePlatform: boolean;
  netnsContainer: string | null;
  gatewayPort: number | null;
  assistantCaCert: string | null;
}

function parseArgs(): HatchArgs {
  const { envVars: cliFlagVars, remaining: args } = parseFeatureFlagArgs(
    process.argv.slice(3),
  );
  const flagEnvVars = { ...readAmbientFlagEnvVars(), ...cliFlagVars };
  const disablePlatformAmbient =
    process.env.VELLUM_DISABLE_PLATFORM?.trim().toLowerCase();
  let disablePlatform =
    disablePlatformAmbient === "true" || disablePlatformAmbient === "1";
  let species: Species = DEFAULT_SPECIES;
  let detached = false;
  let keepAlive = false;
  let name: string | null = null;
  let remote: RemoteHost = DEFAULT_REMOTE;
  let watch = false;
  let sourcePath: string | null = null;
  let preview = false;
  const configValues: Record<string, string> = {};
  let analyze = false;
  let netnsContainer: string | null = null;
  let gatewayPort: number | null = null;
  let assistantCaCert: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: vellum hatch [species] [options]");
      console.log("");
      console.log("Create a new assistant instance.");
      console.log("");
      console.log("Species:");
      console.log("  vellum       Default assistant (default)");
      console.log("  openclaw     OpenClaw adapter");
      console.log("");
      console.log("Options:");
      console.log("  -d                        Run in detached mode");
      console.log("  --name <name>             Custom instance name");
      console.log(
        "  --remote <host>           Remote host (local, docker, custom, vellum)",
      );
      console.log(
        "  --watch                   Run assistant and gateway in watch mode (hot reload on source changes)",
      );
      console.log(
        "  --source <path>           Build images from a local source tree at <path> (no watcher). Useful for callers (e.g. evals) that want each run to pick up local CLI changes.",
        "  --preview                 When pulling published images (no local source), resolve from the preview channel (latest preview release) instead of latest-stable. Also settable via VELLUM_HATCH_CHANNEL=preview.",
      );
      console.log(
        "  --keep-alive              Stay alive after hatch, exit when gateway stops",
      );
      console.log(
        "  --config <key=value>      Set a workspace config value (repeatable)",
      );
      console.log(
        "  --flag <key=value>        Set a feature flag override as VELLUM_FLAG_<KEY> env var (repeatable)",
      );
      console.log(
        "  --analyze                 Emit a structured hatch-timing log line on stdout",
      );
      console.log(
        "  --disable-platform        Suppress all outbound platform API calls",
      );
      console.log(
        "  --netns-container <name>  Join an existing container's network namespace (docker target only) instead of creating a per-instance network. The namespace owner publishes host ports, so --gateway-port is required.",
      );
      console.log(
        "  --gateway-port <port>     Use an explicit host port for the gateway runtime URL instead of auto-allocating. Required with --netns-container.",
      );
      console.log(
        "  --assistant-ca-cert <path>  Trust an extra PEM CA bundle in the assistant container (NODE_EXTRA_CA_CERTS) from process start. Useful behind a TLS-terminating egress proxy.",
      );
      process.exit(0);
    } else if (arg === "-d") {
      detached = true;
    } else if (arg === "--watch") {
      watch = true;
    } else if (arg === "--analyze") {
      analyze = true;
    } else if (arg === "--preview") {
      preview = true;
    } else if (arg === "--source") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --source requires a path argument");
        process.exit(1);
      }
      sourcePath = next;
      i++;
    } else if (arg === "--keep-alive") {
      keepAlive = true;
    } else if (arg === "--name") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --name requires a value");
        process.exit(1);
      }
      try {
        validateAssistantName(next);
      } catch {
        console.error(
          `Error: --name contains invalid characters (path separators or traversal segments are not allowed)`,
        );
        process.exit(1);
      }
      name = next;
      i++;
    } else if (arg === "--remote") {
      const next = args[i + 1];
      if (!next || !VALID_REMOTE_HOSTS.includes(next as RemoteHost)) {
        console.error(
          `Error: --remote requires one of: ${VALID_REMOTE_HOSTS.join(", ")}`,
        );
        process.exit(1);
      }
      remote = next as RemoteHost;
      i++;
    } else if (arg === "--config") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --config requires a key=value argument");
        process.exit(1);
      }
      const eqIndex = next.indexOf("=");
      if (eqIndex <= 0) {
        console.error(
          `Error: --config value must be in key=value format, got '${next}'`,
        );
        process.exit(1);
      }
      const key = next.slice(0, eqIndex);
      const value = next.slice(eqIndex + 1);
      configValues[key] = value;
      i++;
    } else if (arg === "--disable-platform") {
      disablePlatform = true;
    } else if (arg === "--netns-container") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --netns-container requires a container name");
        process.exit(1);
      }
      netnsContainer = next;
      i++;
    } else if (arg === "--gateway-port") {
      const next = args[i + 1];
      const parsed = next ? Number(next) : NaN;
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        console.error(
          "Error: --gateway-port requires an integer port in 1-65535",
        );
        process.exit(1);
      }
      gatewayPort = parsed;
      i++;
    } else if (arg === "--assistant-ca-cert") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --assistant-ca-cert requires a path argument");
        process.exit(1);
      }
      assistantCaCert = next;
      i++;
    } else if (VALID_SPECIES.includes(arg as Species)) {
      species = arg as Species;
    } else {
      console.error(
        `Error: Unknown argument '${arg}'. Valid options: ${VALID_SPECIES.join(", ")}, -d, --watch, --source <path>, --preview, --keep-alive, --name <name>, --remote <${VALID_REMOTE_HOSTS.join("|")}>, --config <key=value>, --flag <key=value>, --analyze, --disable-platform, --netns-container <name>, --gateway-port <port>, --assistant-ca-cert <path>`,
      );
      process.exit(1);
    }
  }

  return {
    species,
    detached,
    keepAlive,
    name,
    remote,
    watch,
    sourcePath,
    preview,
    configValues,
    flagEnvVars,
    analyze,
    disablePlatform,
    netnsContainer,
    gatewayPort,
    assistantCaCert,
  };
}

export { hatchLocal };

function getCliVersion(): string {
  return cliPkg.version ?? "unknown";
}

export async function hatch(): Promise<void> {
  const cliVersion = getCliVersion();
  console.log(`@vellumai/cli v${cliVersion}`);

  const {
    species,
    detached,
    keepAlive,
    name,
    remote,
    watch,
    sourcePath,
    preview,
    configValues,
    flagEnvVars,
    analyze,
    disablePlatform,
    netnsContainer,
    gatewayPort,
    assistantCaCert,
  } = parseArgs();

  if (disablePlatform) {
    process.env.VELLUM_DISABLE_PLATFORM = "true";
    flagEnvVars.VELLUM_DISABLE_PLATFORM = "true";
  }

  if (watch && remote !== "local" && remote !== "docker") {
    console.error(
      "Error: --watch is only supported for local and docker hatch targets.",
    );
    process.exit(1);
  }

  if (sourcePath !== null && remote !== "docker") {
    console.error(
      "Error: --source is only supported for docker hatch targets.",
    );
    process.exit(1);
  }

  if (
    (netnsContainer !== null ||
      gatewayPort !== null ||
      assistantCaCert !== null) &&
    remote !== "docker"
  ) {
    console.error(
      "Error: --netns-container, --gateway-port, and --assistant-ca-cert are only supported for docker hatch targets.",
    );
    process.exit(1);
  }

  if (netnsContainer !== null && gatewayPort === null) {
    console.error(
      "Error: --gateway-port is required with --netns-container (the namespace owner publishes the port before hatch runs).",
    );
    process.exit(1);
  }

  if (remote === "local") {
    await hatchLocal(
      species,
      name,
      watch,
      keepAlive,
      configValues,
      flagEnvVars,
    );
    return;
  }

  if (remote === "docker") {
    await hatchDocker({
      species,
      detached,
      name,
      watch,
      configValues,
      flagEnvVars,
      sourcePath,
      analyze,
      channel: preview ? "preview" : undefined,
      netnsContainer: netnsContainer ?? undefined,
      gatewayPort: gatewayPort ?? undefined,
      assistantCaCertPath: assistantCaCert ?? undefined,
    });
    return;
  }

  if (remote === "vellum") {
    await hatchVellumPlatform();
    return;
  }

  console.error(`Error: Remote host '${remote}' is not yet supported.`);
  process.exit(1);
}

async function hatchVellumPlatform(): Promise<void> {
  const token = readPlatformToken();
  if (!token) {
    console.error("Not logged in. Run `vellum login --token <token>` first.");
    process.exit(1);
  }

  const config = SPECIES_CONFIG.vellum;
  console.log("");
  for (const line of config.art) {
    console.log(`   ${line}`);
  }
  console.log("");
  console.log("   Hatching assistant on Vellum platform...");
  console.log("");

  const { assistant: result } = await hatchAssistant(token);

  const platformUrl = getPlatformUrl();

  saveAssistantEntry({
    assistantId: result.id,
    runtimeUrl: platformUrl,
    cloud: "vellum",
    species: "vellum",
    hatchedAt: new Date().toISOString(),
  });
  setActiveAssistant(result.id);

  console.log(`   ${config.hatchedEmoji}  Your assistant has hatched!`);
  console.log("");
  console.log(`   ID:     ${result.id}`);
  console.log(`   Name:   ${result.name}`);
  console.log(`   Status: ${result.status}`);
  console.log("");
}
