import { spawn } from "child_process";

import {
  findAssistantByName,
  loadLatestAssistant,
  resolveCloud,
} from "../lib/assistant-config";
import { dockerResourceNames } from "../lib/docker";
import type { ServiceName } from "../lib/docker";
import { execAppleContainer } from "../lib/exec-apple-container";
import { sshAppleContainer } from "../lib/ssh-apple-container";

const SERVICE_ALIASES: Record<string, ServiceName> = {
  assistant: "assistant",
  "vellum-assistant": "assistant",
  gateway: "gateway",
  "vellum-gateway": "gateway",
  "credential-executor": "credential-executor",
  "vellum-credential-executor": "credential-executor",
};

function normalizeService(raw: string): ServiceName {
  const normalized = SERVICE_ALIASES[raw];
  if (!normalized) {
    console.error(
      `Unknown service '${raw}'. Valid services: assistant, gateway, credential-executor`,
    );
    process.exit(1);
  }
  return normalized;
}

function resolveDockerContainer(
  instanceName: string,
  service: ServiceName,
): string {
  const res = dockerResourceNames(instanceName);
  switch (service) {
    case "assistant":
      return res.assistantContainer;
    case "gateway":
      return res.gatewayContainer;
    case "credential-executor":
      return res.cesContainer;
  }
}

export async function exec(): Promise<void> {
  const rawArgs = process.argv.slice(3);

  // Only check for help flags before the -- separator so that
  // `vellum exec -- curl --help` passes through correctly.
  const dashDashIndex = rawArgs.indexOf("--");
  const preArgs =
    dashDashIndex === -1 ? rawArgs : rawArgs.slice(0, dashDashIndex);

  if (
    preArgs.includes("--help") ||
    preArgs.includes("-h") ||
    rawArgs.length === 0
  ) {
    console.log(
      "Usage: vellum exec [<name>] [--service <svc>] [-it] -- <command...>",
    );
    console.log("");
    console.log("Execute a command inside an assistant's container.");
    console.log("");
    console.log("Arguments:");
    console.log(
      "  <name>              Name of the assistant (defaults to active)",
    );
    console.log(
      "  <command...>        Command and arguments to run (after --)",
    );
    console.log("");
    console.log("Options:");
    console.log(
      "  --service <svc>     Target service (default: assistant)",
    );
    console.log(
      "  -it                 Interactive mode with TTY (like docker exec -it)",
    );
    console.log("");
    console.log("Services:");
    console.log("  assistant (or vellum-assistant)");
    console.log("  gateway (or vellum-gateway)");
    console.log("  credential-executor (or vellum-credential-executor)");
    console.log("");
    console.log("Examples:");
    console.log("  vellum exec -- ls -la /workspace");
    console.log("  vellum exec -- cat /workspace/NOW.md");
    console.log("  vellum exec -it -- /bin/bash");
    console.log(
      "  vellum exec --service gateway -- cat /tmp/gateway.log",
    );
    process.exit(0);
  }

  if (dashDashIndex === -1) {
    console.error(
      "Error: missing '--' separator before command.\n" +
        "Usage: vellum exec [<name>] -- <command...>",
    );
    process.exit(1);
  }

  const command = rawArgs.slice(dashDashIndex + 1);

  if (command.length === 0) {
    console.error("Error: no command specified after '--'.");
    process.exit(1);
  }

  let nameArg: string | undefined;
  let serviceRaw = "assistant";
  let interactive = false;

  for (let i = 0; i < preArgs.length; i++) {
    if (preArgs[i] === "--service" && preArgs[i + 1]) {
      serviceRaw = preArgs[++i];
    } else if (preArgs[i] === "-it" || preArgs[i] === "-ti") {
      interactive = true;
    } else if (!preArgs[i].startsWith("-")) {
      nameArg = preArgs[i];
    }
  }

  const service = normalizeService(serviceRaw);

  const entry = nameArg
    ? findAssistantByName(nameArg)
    : loadLatestAssistant();

  if (!entry) {
    if (nameArg) {
      console.error(`No assistant instance found with name '${nameArg}'.`);
    } else {
      console.error("No assistant instance found. Run `vellum hatch` first.");
    }
    process.exit(1);
  }

  const cloud = resolveCloud(entry);

  if (cloud === "local") {
    console.error(
      "Cannot exec into a local assistant — it runs directly on this machine.",
    );
    process.exit(1);
  }

  if (cloud === "apple-container") {
    const fullServiceName = `vellum-${service}`;
    if (interactive) {
      await sshAppleContainer(entry, command, fullServiceName);
    } else {
      await execAppleContainer(entry, command, fullServiceName);
    }
    return;
  }

  if (cloud === "docker") {
    const container = resolveDockerContainer(entry.assistantId, service);
    const dockerArgs = interactive
      ? ["exec", "-it", container, ...command]
      : ["exec", container, ...command];

    const child = spawn("docker", dockerArgs, { stdio: "inherit" });
    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0) resolve();
        else {
          process.exitCode = code ?? 1;
          resolve();
        }
      });
      child.on("error", reject);
    });
    return;
  }

  console.error(
    `Error: 'vellum exec' is not supported for ${cloud} instances.`,
  );
  process.exit(1);
}
