import { resolveTargetAssistant } from "../lib/assistant-config.js";
import { dockerResourceNames, wakeContainers } from "../lib/docker.js";
import { wakeLocalAssistant } from "../lib/local-lifecycle.js";

export async function wake(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum wake [<name>] [options]");
    console.log("");
    console.log("Start the assistant and gateway processes.");
    console.log("");
    console.log("Arguments:");
    console.log(
      "  <name>    Name of the assistant to start (default: active or only local)",
    );
    console.log("");
    console.log("Options:");
    console.log(
      "  --watch        Run assistant and gateway in watch mode (hot reload on source changes)",
    );
    console.log(
      "  --foreground   Run assistant in foreground with logs printed to terminal",
    );
    process.exit(0);
  }

  const watch = args.includes("--watch");
  const foreground = args.includes("--foreground");
  const nameArg = args.find((a) => !a.startsWith("-"));
  const entry = resolveTargetAssistant(nameArg);

  if (entry.cloud === "docker") {
    if (watch || foreground) {
      const ignored = [watch && "--watch", foreground && "--foreground"]
        .filter(Boolean)
        .join(" and ");
      console.warn(
        `Warning: ${ignored} ignored for Docker instances (not supported).`,
      );
    }
    const res = dockerResourceNames(entry.assistantId);
    await wakeContainers(res);
    console.log("Docker containers started.");
    console.log("Wake complete.");
    return;
  }

  if (entry.cloud === "apple-container") {
    console.error(
      `Error: '${entry.assistantId}' uses the Apple Containers runtime. Its lifecycle is managed by the macOS app — use the app to start it.`,
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
      `Error: 'vellum wake' only works with local and docker assistants. '${entry.assistantId}' is a ${entry.cloud} instance.`,
    );
    process.exit(1);
  }

  if (!entry.resources) {
    console.error(
      `Error: Local assistant '${entry.assistantId}' is missing resource configuration. Re-hatch to fix.`,
    );
    process.exit(1);
  }

  await wakeLocalAssistant(entry, { watch, foreground });
}
