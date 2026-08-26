import { gatewayToken } from "./gateway/token.js";

function printUsage(): void {
  console.log("Usage: vellum gateway <subcommand>");
  console.log("");
  console.log("Gateway management commands.");
  console.log("");
  console.log("Subcommands:");
  console.log("  token    Manage gateway authentication tokens");
}

export async function gateway(): Promise<void> {
  const args = process.argv.slice(3);
  const subcommand = args[0];

  if (subcommand === "--help" || subcommand === "-h" || !subcommand) {
    printUsage();
    process.exit(0);
  }

  if (subcommand === "token") {
    await gatewayToken();
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  printUsage();
  process.exit(1);
}
