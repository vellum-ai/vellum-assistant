import { SEEDS } from "../lib/environments/seeds.js";
import {
  clearDefaultEnvironment,
  readDefaultEnvironment,
  resolveEnvironmentSource,
  writeDefaultEnvironment,
} from "../lib/environments/resolve.js";

function printUsage(): void {
  console.log("Usage: vellum env <subcommand>");
  console.log("");
  console.log("Manage the default CLI environment.");
  console.log("");
  console.log("Subcommands:");
  console.log("  set <name>   Set the default environment");
  console.log("  get          Show the current environment and its source");
  console.log("  clear        Remove the default, falling back to production");
  console.log("");
  console.log(`Known environments: ${Object.keys(SEEDS).join(", ")}`);
  console.log("");
  console.log("Examples:");
  console.log("  $ vellum env set local    # all commands default to local");
  console.log("  $ vellum env get          # show resolved environment");
  console.log("  $ vellum env clear        # revert to production default");
}

function envSet(name: string | undefined): void {
  if (!name) {
    console.error(
      `Usage: vellum env set <name>\nKnown environments: ${Object.keys(SEEDS).join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }
  if (!SEEDS[name]) {
    console.error(
      `Unknown environment "${name}". Known environments: ${Object.keys(SEEDS).join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }
  writeDefaultEnvironment(name);
  console.log(`Default environment set to "${name}".`);
}

function envGet(): void {
  const { name, source } = resolveEnvironmentSource();
  const sourceLabels: Record<typeof source, string> = {
    flag: "--environment flag",
    env: "VELLUM_ENVIRONMENT env var",
    config: "~/.config/vellum/environment",
    default: "default",
  };
  console.log(`${name} (from ${sourceLabels[source]})`);
}

function envClear(): void {
  const current = readDefaultEnvironment();
  if (!current) {
    console.log("No default environment is set (already using production).");
    return;
  }
  clearDefaultEnvironment();
  console.log(
    `Cleared default environment "${current}". Falling back to production.`,
  );
}

export async function env(): Promise<void> {
  const args = process.argv.slice(3);
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printUsage();
    return;
  }

  switch (sub) {
    case "set":
      envSet(args[1]);
      break;
    case "get":
      envGet();
      break;
    case "clear":
      envClear();
      break;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printUsage();
      process.exitCode = 1;
  }
}
