import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { assertSuccess, type CommandRunner } from "../runtime/command-runner";

/** Host→container port mapping the jail publishes for its namespace tenants. */
export interface JailPublishPort {
  hostPort: number;
  containerPort: number;
}

export interface DockerEgressJailConfig {
  /**
   * Stable run identifier. Names the jail container
   * (`<runId>-egress-jail`) and the Docker network it owns
   * (`<runId>-egress-net`).
   */
  runId: string;
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
   * Host→container port mappings the jail publishes on behalf of the
   * tenant containers that join its network namespace. The jail owns the
   * namespace, so it is the only container in the group that can bind host
   * ports — tenants started with `--network container:<jail>` cannot
   * publish their own. Omit for tenants reached purely via `docker exec`
   * (e.g. Hermes), which need no host ports.
   */
  publishPorts?: ReadonlyArray<JailPublishPort>;
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
  /**
   * Name of the jail container. Tenant containers join its network
   * namespace via `--network container:<netnsContainer>`, so they are born
   * behind the recording proxy + iptables allowlist with no pre-jail
   * window — the rules exist before any tenant daemon's first packet.
   */
  readonly netnsContainer: string;
  /**
   * Host path to the mitmproxy CA PEM the sidecar generated at boot.
   * Tenants must trust this CA before their first outbound TLS (e.g. the
   * assistant via `NODE_EXTRA_CA_CERTS`, Hermes via `installRecordingCa`),
   * otherwise the intercepted handshake fails closed.
   */
  readonly caCertPath: string;
  stop(): Promise<void>;
  readUsageRecords(): Promise<Array<Record<string, unknown>>>;
}

/**
 * Resolve a free TCP port on the host by binding to port 0 and reading
 * back the OS-assigned port. The jail must publish host ports before any
 * tenant exists, so the caller allocates here and hands the result to both
 * the jail (`publishPorts`) and the tenant (e.g. `hatch --gateway-port`).
 *
 * There is an unavoidable TOCTOU window between releasing the probe socket
 * and Docker binding the port; in the evals sandbox (one run per host port
 * range at a time) this is not a contended resource.
 */
export async function findOpenHostPort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    // Bind the probe to the IPv4 wildcard explicitly. With no host, the
    // runtime picks the unspecified address — Bun defaults that to IPv6
    // `::`, which fails ("Failed to listen at ::") on hosts where IPv6 is
    // disabled (no `/proc/sys/net/ipv6`), as in container sandboxes. Docker
    // publishes the resulting port on `0.0.0.0`, so probing the same IPv4
    // wildcard keeps the free-port check consistent with where the port is
    // actually bound.
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to resolve an open host port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * Hosts the recording jail allows model API traffic to. The mitmproxy
 * addon (`addon.py`) reconstructs per-request token usage from the
 * providers it recognizes (Anthropic today); the rest flow through
 * unparsed but reachable, so their runs simply lack a recorded cost.
 * Keeping the list to genuine model providers means the addon never
 * tries to parse usage out of a github tarball — non-model infra hosts
 * belong in DEFAULT_INFRA_ALLOW_HOSTS.
 *
 * `api.fireworks.ai` serves open-weight models over an OpenAI-compatible
 * API (e.g. MiniMax M3 on US infrastructure for the `vellum-minimax`
 * profile).
 */
export const DEFAULT_MODEL_ALLOW_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "api.fireworks.ai",
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
 * Hosts the Vellum assistant downloads its on-device embedding stack from
 * at daemon startup, when a profile leaves memory on the default local
 * embedder (`Xenova/bge-small-en-v1.5`). The daemon's
 * `EmbeddingRuntimeManager` fetches the ONNX runtime + transformers
 * tarballs from npm, then transformers.js pulls the model weights from
 * HuggingFace (large files redirect to its Xet/CloudFront CDN). Without
 * these the embedder can't initialize in the fail-closed jail, dense
 * memory recall silently degrades, and a long-memory benchmark scores
 * near zero for reasons unrelated to the model under test.
 *
 * These are bulk asset downloads, **not** model-inference endpoints: they
 * are deliberately kept out of the recording proxy's TLS interception
 * (`RECORDING_TLS_HOSTS_RE` in `recording/entrypoint.sh`) so the embedding
 * worker validates each origin's genuine certificate, and out of
 * `DEFAULT_MODEL_ALLOW_HOSTS` so the addon never tries to parse usage out
 * of a model-weight blob.
 *
 * They are **Vellum-specific**: only the Vellum adapter runs the on-device
 * embedder, so only `VELLUM_ALLOW_HOSTS` folds them in. They are kept out
 * of `DEFAULT_ALLOW_HOSTS` so a Hermes run — which never embeds locally —
 * can't make unmetered npm/HuggingFace egress, preserving the honest
 * model-provider-only allowlist that keeps cross-species cost comparisons
 * fair.
 */
export const DEFAULT_EMBEDDING_ALLOW_HOSTS = [
  "registry.npmjs.org",
  "huggingface.co",
  "cas-bridge.xethub.hf.co",
  "us.aws.cdn.hf.co",
];

/**
 * The default allowlist applied when `applyDockerEgressJail` is called
 * without an explicit `allowHosts`. Scoped to model-inference providers
 * plus the Vellum platform infra every species needs, so it is the honest
 * cross-species baseline: a Hermes run reaches exactly the model providers
 * a Vellum run does and nothing more. Species with extra egress needs (the
 * Vellum on-device embedder — see `VELLUM_ALLOW_HOSTS`) opt in explicitly
 * rather than widening this shared default. Concatenation order doesn't
 * matter — the iptables script (`apply-recording-jail.sh`) iterates and
 * adds each host independently.
 */
export const DEFAULT_ALLOW_HOSTS = [
  ...DEFAULT_MODEL_ALLOW_HOSTS,
  ...DEFAULT_INFRA_ALLOW_HOSTS,
];

/**
 * The allowlist the Vellum adapter passes to `applyDockerEgressJail`. It
 * extends the shared `DEFAULT_ALLOW_HOSTS` with the on-device embedder's
 * download hosts (`DEFAULT_EMBEDDING_ALLOW_HOSTS`), which the Vellum daemon
 * needs to initialize dense memory recall in the jail. Hermes intentionally
 * does not use this — it never embeds locally — so its jail stays on the
 * model-provider-only `DEFAULT_ALLOW_HOSTS`.
 */
export const VELLUM_ALLOW_HOSTS = [
  ...DEFAULT_ALLOW_HOSTS,
  ...DEFAULT_EMBEDDING_ALLOW_HOSTS,
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
 * Install the recording sidecar's CA into a tenant container's system
 * trust store via `docker cp` + `docker exec ... update-ca-certificates`.
 * Required for any host listed in mitmproxy's `--allow-hosts` regex —
 * without it, the TLS handshake fails before the addon's request hook
 * sees the URL, and recording / mocking are both silently dead code.
 *
 * Used for tenants whose daemon does not reach out until after setup
 * completes (e.g. Hermes idles until its first message), so the trust
 * store can be patched post-start. Tenants that open outbound TLS at
 * process start (e.g. the assistant daemon) must instead trust the CA
 * from launch — see `hatch --assistant-ca-cert` / `NODE_EXTRA_CA_CERTS`.
 *
 * Assumes a Debian-family base image (`update-ca-certificates`). Both the
 * assistant and Hermes containers are Debian; if that ever changes, this
 * step needs a per-base dispatch (alpine ships the tool from a different
 * package; minimal images ship neither).
 */
export async function installRecordingCa(
  runner: CommandRunner,
  recordingDir: string,
  tenantContainer: string,
): Promise<void> {
  const caPath = await waitForRecordingCa(recordingDir);
  const cp = await runner.run("docker", [
    "cp",
    caPath,
    `${tenantContainer}:${ASSISTANT_CA_TARGET}`,
  ]);
  assertSuccess(cp, `copy recording CA into ${tenantContainer}`);
  const update = await runner.run("docker", [
    "exec",
    tenantContainer,
    "update-ca-certificates",
  ]);
  assertSuccess(update, `update CA trust store in ${tenantContainer}`);
}

/** Deterministic Docker names make cleanup idempotent and debuggable. */
export function dockerEgressJailContainerName(runId: string): string {
  return `${runId}-egress-jail`;
}

/** Name of the Docker network the jail owns for a run. */
export function dockerEgressJailNetworkName(runId: string): string {
  return `${runId}-egress-net`;
}

/**
 * Create the recording egress jail as the owner of a fresh network
 * namespace, before any tenant container exists.
 *
 * The mitmproxy sidecar boots on its own Docker network with
 * `NET_ADMIN`, installs the iptables allowlist + NAT REDIRECT into its
 * own namespace, and generates the interception CA — all while no tenant
 * is running. Tenants (the assistant/gateway/CES via `hatch
 * --netns-container`, or Hermes via `--network container:<jail>`) are then
 * born into the already-jailed stack: every outbound model request is
 * teed through mitmproxy from the tenant's very first packet, so
 * token-counting + cost reconstruction has no pre-jail window to leak
 * through.
 *
 * Because the jail owns the namespace, it is also the container that
 * publishes host ports for the group (`publishPorts`). It must outlive its
 * tenants: tear tenants down first, then call `stop()` (removes the jail
 * container, then its network).
 *
 * The recording sidecar is mandatory — every eval run produces
 * ground-truth usage out of the box, so there is no non-recording mode.
 */
export async function applyDockerEgressJail(
  runner: CommandRunner,
  config: DockerEgressJailConfig,
): Promise<DockerEgressJail> {
  const allowHosts = config.allowHosts ?? DEFAULT_ALLOW_HOSTS;
  const jailContainer = dockerEgressJailContainerName(config.runId);
  const jailNetwork = dockerEgressJailNetworkName(config.runId);
  const recordingDir = config.recordingDir;
  const recordingImage = config.recordingImage ?? DEFAULT_RECORDING_IMAGE;
  const dockerfileDir =
    config.recordingDockerfileDir ?? defaultRecordingDockerfileDir();

  await runner
    .run("docker", ["rm", "-f", jailContainer])
    .catch(() => undefined);
  await runner
    .run("docker", ["network", "rm", jailNetwork])
    .catch(() => undefined);

  const build = await runner.run("docker", [
    "build",
    "-t",
    recordingImage,
    dockerfileDir,
  ]);
  assertSuccess(build, `build recording egress jail image ${recordingImage}`);

  const network = await runner.run("docker", [
    "network",
    "create",
    jailNetwork,
  ]);
  assertSuccess(network, `create egress jail network ${jailNetwork}`);

  const publishArgs = (config.publishPorts ?? []).flatMap((p) => [
    "-p",
    `${p.hostPort}:${p.containerPort}`,
  ]);

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
    jailNetwork,
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
    ...publishArgs,
    ...fixturesArgs,
    recordingImage,
  ]);
  assertSuccess(result, `create recording docker egress jail ${jailContainer}`);

  // Block until the sidecar has written the interception CA, so callers
  // can hand its path to tenants (`hatch --assistant-ca-cert`) knowing the
  // file exists. The sidecar's iptables rules are installed in the same
  // entrypoint before `mitmdump` execs, so once the CA is present the jail
  // is fully armed.
  const caCertPath = await waitForRecordingCa(recordingDir);

  return {
    netnsContainer: jailContainer,
    caCertPath,
    readUsageRecords: () => readRecordingUsage(recordingDir),
    stop: async () => {
      await runner
        .run("docker", ["rm", "-f", jailContainer])
        .catch(() => undefined);
      await runner
        .run("docker", ["network", "rm", jailNetwork])
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
 * the assistant — any of the three can crash-loop or exit during boot,
 * and their `docker inspect` output is the most actionable artifact for
 * diagnosing a failed hatch.
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
