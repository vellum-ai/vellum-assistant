import {
  lookupAssistantByIdentifier,
  formatAssistantLookupError,
} from "../../lib/assistant-config.js";
import {
  loadGuardianToken,
  refreshGuardianToken,
} from "../../lib/guardian-token.js";

function printUsage(): void {
  console.log("Usage: vellum gateway token <subcommand> <assistantId>");
  console.log("");
  console.log("Manage gateway authentication tokens.");
  console.log("");
  console.log("Subcommands:");
  console.log("  get       Print the current guardian access token");
  console.log("  refresh   Refresh an expired access token and print it");
}

export async function gatewayToken(): Promise<void> {
  const args = process.argv.slice(4);
  const subcommand = args[0];

  if (subcommand === "--help" || subcommand === "-h" || !subcommand) {
    printUsage();
    process.exit(0);
  }

  if (subcommand !== "get" && subcommand !== "refresh") {
    console.error(`Unknown subcommand: ${subcommand}`);
    printUsage();
    process.exit(1);
  }

  const assistantId = args[1];
  if (!assistantId) {
    console.error("Missing required argument: <assistantId>");
    printUsage();
    process.exit(1);
  }

  const result = lookupAssistantByIdentifier(assistantId);
  if (result.status !== "found") {
    console.error(formatAssistantLookupError(assistantId, result));
    process.exit(1);
  }
  const entry = result.entry;

  const tokenData = loadGuardianToken(entry.assistantId);
  if (!tokenData) {
    console.error("No guardian token found for this assistant.");
    process.exit(1);
  }

  if (subcommand === "get") {
    console.log(tokenData.accessToken);
    return;
  }

  const gatewayUrl = entry.localUrl || entry.runtimeUrl;
  if (!gatewayUrl) {
    console.error("No gateway URL found for this assistant.");
    process.exit(1);
  }

  const refreshed = await refreshGuardianToken(gatewayUrl, entry.assistantId);
  if (!refreshed) {
    console.error("Failed to refresh guardian token.");
    process.exit(1);
  }

  console.log(refreshed.accessToken);
}
