function printHelp(): void {
  console.log(
    "Usage: vellum teleport --from <assistant> --to <assistant> [options]",
  );
  console.log("");
  console.log(
    "Transfer assistant data between local and platform environments.",
  );
  console.log("");
  console.log("Options:");
  console.log("  --from <name>   Source assistant to export data from");
  console.log("  --to <name>     Target assistant to import data into");
  console.log(
    "  --dry-run       Preview the transfer without applying changes",
  );
  console.log("  --help, -h      Show this help");
}

function parseArgs(argv: string[]): {
  from: string | undefined;
  to: string | undefined;
  dryRun: boolean;
  help: boolean;
} {
  let from: string | undefined;
  let to: string | undefined;
  let dryRun = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from" && i + 1 < argv.length) {
      from = argv[++i];
    } else if (arg === "--to" && i + 1 < argv.length) {
      to = argv[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  return { from, to, dryRun, help };
}

export async function teleport(): Promise<void> {
  const args = process.argv.slice(3);
  const { from, to, help } = parseArgs(args);

  if (help) {
    printHelp();
    process.exit(0);
  }

  if (!from || !to) {
    printHelp();
    process.exit(1);
  }

  console.log(`Teleporting from ${from} to ${to}...`);
}
