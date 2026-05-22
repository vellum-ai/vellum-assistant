import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { assertSuccess, type CommandRunner } from "../runtime/command-runner";

export interface DockerEgressJailConfig {
  /** Container whose network namespace should be restricted. */
  containerName: string;
  /** Hostnames allowed for outbound model traffic. */
  allowHosts?: string[];
  /**
   * Host-side run artifact directory. The recording mitmproxy sidecar
   * mounts this dir at `/recording` so usage records land in
   * `egress-usage.ndjson`. Required: evals always run with the recording
   * sidecar now, so the host-side destination must always be provided.
   */
  recordingDir: string;
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

const DEFAULT_RECORDING_IMAGE = "vellum-evals-recording-jail:local";
const RECORDING_USAGE_FILENAME = "egress-usage.ndjson";

function egressDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function defaultRecordingDockerfileDir(): string {
  return resolve(egressDir(), "recording");
}

function usagePath(recordingDir: string): string {
  return resolve(recordingDir, RECORDING_USAGE_FILENAME);
}

async function readRecordingUsage(
  recordingDir: string,
): Promise<Array<Record<string, unknown>>> {
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
 * Launches the recording mitmproxy sidecar attached to the target
 * container's network namespace. The sidecar installs the iptables
 * allowlist AND tees every outbound model request through mitmproxy
 * so token-counting + cost reconstruction works end-to-end. The policy
 * and the recording remain attached to the namespace until the target
 * container is retired.
 *
 * This is the only egress-jail mode evals support — the previous
 * non-recording variant was removed per PR #31348 review feedback so
 * every eval run produces ground-truth usage out of the box.
 */
export async function applyDockerEgressJail(
  runner: CommandRunner,
  config: DockerEgressJailConfig,
): Promise<DockerEgressJail> {
  const allowHosts = config.allowHosts ?? DEFAULT_MODEL_ALLOW_HOSTS;
  const jailContainer = dockerEgressJailContainerName(config.containerName);
  const recordingDir = config.recordingDir;
  const recordingImage = config.recordingImage ?? DEFAULT_RECORDING_IMAGE;
  const dockerfileDir =
    config.recordingDockerfileDir ?? defaultRecordingDockerfileDir();

  await runner
    .run("docker", ["rm", "-f", jailContainer])
    .catch(() => undefined);

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

export function vellumDockerAssistantContainer(instanceName: string): string {
  return `${instanceName}-assistant`;
}
