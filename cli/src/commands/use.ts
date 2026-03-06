import {
  findAssistantByName,
  getActiveAssistant,
  setActiveAssistant,
} from "../lib/assistant-config.js";

export async function use(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum use [<name>]");
    console.log("");
    console.log("Set the active assistant for commands.");
    console.log("");
    console.log("Arguments:");
    console.log("  <name>    Name of the assistant to make active");
    console.log("");
    console.log(
      "When called without a name, prints the current active assistant.",
    );
    process.exit(0);
  }

  const name = args.find((a) => !a.startsWith("-"));

  if (!name) {
    const active = getActiveAssistant();
    if (active) {
      console.log(`Active assistant: ${active}`);
    } else {
      console.log("No active assistant set.");
    }
    return;
  }

  const entry = findAssistantByName(name);
  if (!entry) {
    console.error(`No assistant found with name '${name}'.`);
    process.exit(1);
  }

  setActiveAssistant(name);
  console.log(`Active assistant set to '${name}'.`);
}
