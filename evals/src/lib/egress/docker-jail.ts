import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSuccess, type CommandRunner } from "../runtime/command-runner";

export interface DockerEgressJailConfig {
  /** Container whose network namespace should be restricted. */
  containerName: string;
  /** Hostnames allowed for outbound model traffic. */
  allowHosts?: string[];
  /** Image containing sh, iptables, and getent. */
  jailImage?: string;
  /** Optional override for the host-side policy script path. */
  scriptPath?: string;
}

export interface DockerEgressJail {
  stop(): Promise<void>;
}

export const DEFAULT_MODEL_ALLOW_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
];

const DEFAULT_JAIL_IMAGE = "ghcr.io/nicolaka/netshoot:v0.13";

function defaultScriptPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "docker-egress-jail.sh",
  );
}

/** Deterministic Docker names make cleanup idempotent and debuggable. */
export function dockerEgressJailContainerName(containerName: string): string {
  return `${containerName}-egress-jail`;
}

/**
 * Apply a block-by-default outbound policy to an already-created Docker
 * container without requiring changes to the species being evaluated.
 *
 * The helper launches a short-lived NET_ADMIN sidecar in the target
 * container's network namespace. The sidecar installs iptables rules there,
 * then exits. The policy remains attached to the namespace until the target
 * container is retired.
 */
export async function applyDockerEgressJail(
  runner: CommandRunner,
  config: DockerEgressJailConfig,
): Promise<DockerEgressJail> {
  const allowHosts = config.allowHosts ?? DEFAULT_MODEL_ALLOW_HOSTS;
  const jailContainer = dockerEgressJailContainerName(config.containerName);
  const jailImage = config.jailImage ?? DEFAULT_JAIL_IMAGE;
  const scriptPath = config.scriptPath ?? defaultScriptPath();

  await runner
    .run("docker", ["rm", "-f", jailContainer])
    .catch(() => undefined);

  const result = await runner.run("docker", [
    "run",
    "--rm",
    "--name",
    jailContainer,
    "--network",
    `container:${config.containerName}`,
    "--cap-add",
    "NET_ADMIN",
    "--label",
    "evals.vellum.ai/egress-jail=1",
    "-e",
    `ALLOW_HOSTS=${allowHosts.join(",")}`,
    "-v",
    `${scriptPath}:/evals/apply-egress-jail.sh:ro`,
    jailImage,
    "sh",
    "/evals/apply-egress-jail.sh",
  ]);
  assertSuccess(result, `apply docker egress jail to ${config.containerName}`);

  return {
    stop: async () => {
      await runner
        .run("docker", ["rm", "-f", jailContainer])
        .catch(() => undefined);
    },
  };
}

export function vellumDockerAssistantContainer(instanceName: string): string {
  return `${instanceName}-assistant`;
}
