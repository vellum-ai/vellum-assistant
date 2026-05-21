import {
  formatAssistantLookupError,
  formatAssistantReference,
  getActiveAssistant,
  lookupAssistantByIdentifier,
  setActiveAssistant,
} from "../lib/assistant-config.js";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";

export async function use(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum use [<name-or-id>]");
    console.log("");
    console.log("Set the active assistant for commands.");
    console.log("");
    console.log("Arguments:");
    console.log(
      "  <name-or-id>    Assistant display name or ID to make active",
    );
    console.log("");
    console.log(
      "When called without a name, prints the current active assistant.",
    );
    process.exit(0);
  }

  const name = parseAssistantTargetArg(args);

  if (!name) {
    const active = getActiveAssistant();
    if (active) {
      const result = lookupAssistantByIdentifier(active);
      if (result.status === "found") {
        console.log(
          `Active assistant: ${formatAssistantReference(result.entry)}`,
        );
      } else {
        console.log(`Active assistant: ${active} (not found in lockfile)`);
      }
    } else {
      console.log("No active assistant set.");
    }
    return;
  }

  const result = lookupAssistantByIdentifier(name);
  if (result.status !== "found") {
    console.error(formatAssistantLookupError(name, result));
    process.exit(1);
  }

  setActiveAssistant(result.entry.assistantId);
  console.log(
    `Active assistant set to ${formatAssistantReference(result.entry)}.`,
  );
}
