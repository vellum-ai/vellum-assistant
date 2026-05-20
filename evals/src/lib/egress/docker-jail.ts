import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
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
  /**
   * Host-side run artifact directory. When set, evals launches the recording
   * mitmproxy sidecar instead of the non-recording one and mounts this dir at
   * `/recording` so usage records land in `egress-usage.ndjson`.
   */
  recordingDir?: string;
  /** Prebuilt recording sidecar image. Defaults to a local evals image tag. */
  recordingImage?: string;
  /** Optional override for the recording sidecar Dockerfile directory. */
  recordingDockerfileDir?: string;
}

export interface DockerEgressJail {
  stop(): Promise<void>;
  readUsageRecords(): Promise<Array<Record<string, unknown>>>;
}

export const DEFAULT_MODEL_ALLOW_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
];

const DEFAULT_JAIL_IMAGE = "ghcr.io/nicolaka/netshoot:v0.13";
const DEFAULT_RECORDING_IMAGE = "vellum-evals-recording-jail:local";
const RECORDING_USAGE_FILENAME = "egress-usage.ndjson";

function egressDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function defaultScriptPath(): string {
  return resolve(egressDir(), "docker-egress-jail.sh");
}

function defaultRecordingDockerfileDir(): string {
  return resolve(egressDir(), "recording");
}

function usagePath(recordingDir: string): string {
  return resolve(recordingDir, RECORDING_USAGE_FILENAME);
}

async function readRecordingUsage(
  recordingDir: string | undefined,
): Promise<Array<Record<string, unknown>>> {
  if (!recordingDir) return [];
  let raw: string;
  try {
    raw = await readFile(usagePath(recordingDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
  const recordingDir = config.recordingDir;

  await runner
    .run("docker", ["rm", "-f", jailContainer])
    .catch(() => undefined);

  if (recordingDir) {
    const recordingImage = config.recordingImage ?? DEFAULT_RECORDING_IMAGE;
    const dockerfileDir =
      config.recordingDockerfileDir ?? defaultRecordingDockerfileDir();
    const build = await runner.run("docker", [
      "build",
      "-t",
      recordingImage,
      dockerfileDir,
    ]);
    assertSuccess(build, `build recording egress jail image ${recordingImage}`);

    const result = await runner.run("docker", [
      "run",
      "-d",
      "--name",
      jailContainer,
      "--network",
      `container:${config.containerName}`,
      "--cap-add",
      "NET_ADMIN",
      "--label",
      "evals.vellum.ai/egress-jail=1",
      "--label",
      "evals.vellum.ai/egress-recording=1",
      "-e",
      `ALLOW_HOSTS=${allowHosts.join(",")}`,
      "-v",
      `${resolve(recordingDir)}:/recording`,
      recordingImage,
    ]);
    assertSuccess(
      result,
      `apply recording docker egress jail to ${config.containerName}`,
    );

    return {
      readUsageRecords: () => readRecordingUsage(recordingDir),
      stop: async () => {
        await runner
          .run("docker", ["rm", "-f", jailContainer])
          .catch(() => undefined);
      },
    };
  }

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
    readUsageRecords: async () => [],
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
