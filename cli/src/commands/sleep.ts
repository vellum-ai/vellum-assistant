import { resolveTargetAssistant } from "../lib/assistant-config.js";
import { dockerResourceNames, sleepContainers } from "../lib/docker.js";
import { sleepLocalAssistant } from "../lib/local-lifecycle.js";

export async function sleep(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum sleep [<name>] [--force]");
    console.log("");
    console.log("Stop the assistant and gateway processes.");
    console.log("");
    console.log("Arguments:");
    console.log(
      "  <name>    Name of the assistant to stop (default: active or only local)",
    );
    console.log("");
    console.log("Options:");
    console.log(
      "  --force   Stop the assistant even if a phone call keepalive lease is active",
    );
    process.exit(0);
  }

  const force = args.includes("--force");
  const nameArg = args.find((a) => !a.startsWith("-"));
  const entry = resolveTargetAssistant(nameArg);

  if (entry.cloud === "docker") {
    const res = dockerResourceNames(entry.assistantId);
    await sleepContainers(res);
    console.log("Docker containers stopped.");
    return;
  }

  if (entry.cloud === "apple-container") {
    console.error(
      `Error: '${entry.assistantId}' uses the Apple Containers runtime. Its lifecycle is managed by the macOS app — use the app to stop it.`,
    );
    process.exit(1);
  }

  if (entry.cloud === "paired") {
    console.error(
      `Error: '${entry.assistantId}' is a remote assistant paired from another machine — its lifecycle is managed on its host machine, not here. Use \`vellum client ${entry.assistantId}\` to chat with it.`,
    );
    process.exit(1);
  }

  if (entry.cloud && entry.cloud !== "local") {
    console.error(
      `Error: 'vellum sleep' only works with local and docker assistants. '${entry.assistantId}' is a ${entry.cloud} instance.`,
    );
    process.exit(1);
  }

  try {
    await sleepLocalAssistant(entry, { force });
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
