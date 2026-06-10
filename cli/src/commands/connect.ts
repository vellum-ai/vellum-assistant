import { connectImport } from "./connect/import.js";

function printUsage(): void {
  console.log("Usage: vellum connect [beta] <subcommand>");
  console.log("");
  console.log("Connect to an assistant paired from another machine.");
  console.log("");
  console.log("Subcommands:");
  console.log(
    "  import    Import a pairing bundle from `vellum pair` and register it",
  );
}

export async function connect(): Promise<void> {
  const args = process.argv.slice(3);
  const subcommand = args[0];

  if (subcommand === "--help" || subcommand === "-h" || !subcommand) {
    printUsage();
    process.exit(0);
  }

  if (subcommand === "import") {
    await connectImport();
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  printUsage();
  process.exit(1);
}
