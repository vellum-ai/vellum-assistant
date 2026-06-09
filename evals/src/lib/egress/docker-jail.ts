import { dirname, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
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
  /**
   * Host path to bind-mount at `/fixtures` inside the recording sidecar.
   *
   * When provided, the addon's `mock_github_handler.py` serves
   * `assistant plugins install` traffic from this directory instead of
   * letting it reach api.github.com / raw.githubusercontent.com. The
   * layout mirrors `plugins/<name>/...` in the
   * vellum-assistant repo — one subdirectory per plugin name.
   *
   * Omit to leave plugin install requests unmocked — they then hit
   * the iptables DROP-default and fail closed at TCP connect time.
   */
  pluginFixturesDir?: string;
}

export interface DockerEgressJail {
  stop(): Promise<void>;
  readUsageRecords(): Promise<Array<Record<string, unknown>>>;
}

/**
 * Hosts the recording jail allows model API traffic to. The mitmproxy
 * addon (`addon.py`) recognizes these specifically and reconstructs
 * per-request token usage from their response shapes — keeping the
 * list focused so the addon doesn't accidentally try to parse usage
 * out of a github tarball.
 */
export const DEFAULT_MODEL_ALLOW_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
];

/**
 * Non-model hosts the assistant container needs reachable for eval
 * setup to succeed.
 *
 * **{prod,staging,dev,test}-platform.vellum.ai**: the assistant's
 * skills/feature-flag/catalog calls (`VELLUM_PLATFORM_URL` env var,
 * resolved per environment seed in
 * `cli/src/lib/environments/seeds.ts`). Including the non-prod
 * variants up-front means an eval against a non-prod environment
 * doesn't silently fall back to a blocked egress; the egress layer
 * doesn't care which is "active" — only that the host the assistant
 * actually calls matches an allowlisted name.
 *
 * **GitHub hosts are deliberately not allowlisted.**
 * `assistant plugins install <name>` traffic to `api.github.com` and
 * `raw.githubusercontent.com` is intercepted by the recording
 * addon's mock-github handler when `pluginFixturesDir` is set on
 * `applyDockerEgressJail`. The NAT REDIRECT rule installed by
 * `apply-recording-jail.sh` bounces 443 traffic into mitmproxy
 * before the filter table sees the original GitHub destination, so
 * mitmproxy synthesizes responses from disk without ever needing
 * upstream GitHub egress. When `pluginFixturesDir` is omitted, plugin
 * install fails closed against the DROP-default — which is the
 * intended behavior for evals that don't depend on plugins.
 *
 * Kept separate from `DEFAULT_MODEL_ALLOW_HOSTS` so the addon's
 * provider-recognition logic stays bounded.
 */
export const DEFAULT_INFRA_ALLOW_HOSTS = [
  "platform.vellum.ai",
  "staging-platform.vellum.ai",
  "dev-platform.vellum.ai",
  "test-platform.vellum.ai",
];

/**
 * The default allowlist applied when `applyDockerEgressJail` is called
 * without an explicit `allowHosts`. Concatenation order doesn't matter
 * — the iptables script (`apply-recording-jail.sh`) iterates and adds
 * each host independently.
 */
export const DEFAULT_ALLOW_HOSTS = [
  ...DEFAULT_MODEL_ALLOW_HOSTS,
  ...DEFAULT_INFRA_ALLOW_HOSTS,
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

const RECORDING_CA_FILENAME = "mitmproxy-ca-cert.pem";
const ASSISTANT_CA_TARGET =
  "/usr/local/share/ca-certificates/vellum-evals-mitmproxy.crt";
const CA_POLL_TIMEOUT_MS = 10_000;
const CA_POLL_INTERVAL_MS = 100;

/**
 * Wait for the recording sidecar's entrypoint to copy the mitmproxy
 * CA onto the host-mounted recording dir. The CA file is pre-generated
 * at image build time (see `recording/Dockerfile`) and `entrypoint.sh`
 * copies it to `/recording/mitmproxy-ca-cert.pem` within the first few
 * hundred ms of boot. We poll because `docker run -d` returns
 * immediately and the entrypoint might still be executing the iptables
 * setup when control returns.
 */
async function waitForRecordingCa(recordingDir: string): Promise<string> {
  const caPath = resolve(recordingDir, RECORDING_CA_FILENAME);
  const start = Date.now();
  while (Date.now() - start < CA_POLL_TIMEOUT_MS) {
    try {
      await stat(caPath);
      return caPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await new Promise((r) => setTimeout(r, CA_POLL_INTERVAL_MS));
    }
  }
  throw new Error(
    `recording sidecar did not write CA to ${caPath} within ` +
      `${CA_POLL_TIMEOUT_MS}ms — assistant container will not trust ` +
      `mitmproxy and any TLS-intercepted host will fail closed`,
  );
}

/**
 * Install the recording sidecar's CA into the assistant container's
 * system trust store. Required for any host listed in mitmproxy's
 * `--allow-hosts` regex — without it, TLS handshake fails before the
 * addon's request hook sees the URL, and recording / mocking are both
 * silently dead code.
 *
 * Uses `docker cp` + `docker exec ... update-ca-certificates`, which
 * assumes a Debian-family base image. The current assistant container
 * is Debian; if that ever changes, this step needs to grow a per-base
 * dispatch (alpine ships `update-ca-certificates` too but from a
 * different package; minimal images ship neither).
 */
async function installRecordingCa(
  runner: CommandRunner,
  recordingDir: string,
  assistantContainer: string,
): Promise<void> {
  const caPath = await waitForRecordingCa(recordingDir);
  const cp = await runner.run("docker", [
    "cp",
    caPath,
    `${assistantContainer}:${ASSISTANT_CA_TARGET}`,
  ]);
  assertSuccess(cp, `copy recording CA into ${assistantContainer}`);
  const update = await runner.run("docker", [
    "exec",
    assistantContainer,
    "update-ca-certificates",
  ]);
  assertSuccess(update, `update CA trust store in ${assistantContainer}`);
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
  const allowHosts = config.allowHosts ?? DEFAULT_ALLOW_HOSTS;
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

  const fixturesArgs = config.pluginFixturesDir
    ? [
        "-v",
        `${resolve(config.pluginFixturesDir)}:/fixtures:ro`,
        "-e",
        "PLUGIN_FIXTURES_DIR=/fixtures",
      ]
    : [];

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
    ...fixturesArgs,
    recordingImage,
  ]);
  assertSuccess(
    result,
    `apply recording docker egress jail to ${config.containerName}`,
  );

  // Hand the mitmproxy CA off to the assistant container BEFORE any
  // setup command runs. The CA needs to be in the trust store before
  // the first TLS-intercepted call (anthropic for recording, github
  // for plugin mocking), otherwise mitmproxy's interception fails
  // closed and the addon hooks never fire.
  await installRecordingCa(runner, recordingDir, config.containerName);

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

/**
 * Sibling container names the Vellum StatefulSet provisions alongside
 * the main assistant container. Kept in sync with
 * `cli/src/lib/docker.ts:dockerResourceNames`.
 *
 * Exposed for the vellum adapter's hatch-failure forensics so we can
 * snapshot every container the hatch could have left behind, not just
 * the assistant. The gateway container is the one that fails to bind
 * host port 20100 in the canonical "address already in use" failure
 * mode — its docker inspect is the most actionable artifact.
 */
export function vellumDockerSiblingContainers(
  instanceName: string,
): readonly string[] {
  return [
    `${instanceName}-assistant`,
    `${instanceName}-gateway`,
    `${instanceName}-credential-executor`,
  ];
}
