import { randomBytes } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  watch as fsWatch,
} from "fs";
import { arch, platform } from "os";
import { dirname, join, resolve } from "path";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../package.json";

import {
  findAssistantByName,
  saveAssistantEntry,
  setActiveAssistant,
} from "./assistant-config";
import type { AssistantEntry } from "./assistant-config";
import { buildHatchConfigValues, writeInitialConfig } from "./config-utils";
import { buildServiceRunArgs } from "./statefulset.js";
import type { Species } from "./constants";
import { getOrCreateHostDeviceId } from "./device-id.js";
import { ASSISTANT_INTERNAL_PORT, getDefaultPorts } from "./environments/paths.js";
import { getCurrentEnvironment } from "./environments/resolve.js";
import { leaseGuardianToken } from "./guardian-token";
import { logHatchNextSteps } from "./hatch-next-steps.js";
import { isVellumProcess, stopProcess } from "./process";
import { generateInstanceName } from "./random-name";
import {
  HOST_IMAGE_LOADER_URL,
  isLocalBuildRef,
  loadImageViaHost,
} from "./host-image-loader.js";
import {
  fetchLatestVersion,
  resolveImageRefs,
  type ReleaseChannel,
} from "./platform-releases.js";
import {
  configureHatchProviderApiKey,
  formatProviderName,
  resolveHatchProvider,
} from "./provider-secrets.js";
import { findOpenPort } from "./port-allocator.js";
import { exec, execOutput, execWithStdin } from "./step-runner";
import {
  closeLogFile,
  openLogFile,
  resetLogFile,
  writeToLogFile,
} from "./xdg-log";
import { emitProgress } from "./desktop-progress.js";

export type ServiceName = "assistant" | "credential-executor" | "gateway";

const DOCKERHUB_ORG = "vellumai";
export const DOCKERHUB_IMAGES: Record<ServiceName, string> = {
  assistant: `${DOCKERHUB_ORG}/vellum-assistant`,
  "credential-executor": `${DOCKERHUB_ORG}/vellum-credential-executor`,
  gateway: `${DOCKERHUB_ORG}/vellum-gateway`,
};

/** Internal ports exposed by each service's Dockerfile. Re-exported from environments/paths.ts. */
export {
  ASSISTANT_INTERNAL_PORT,
  GATEWAY_INTERNAL_PORT,
} from "./environments/paths.js";
import { loopbackSafeFetch } from "./loopback-fetch.js";

/** Max time to wait for the assistant container to emit the readiness sentinel. */
export const DOCKER_READY_TIMEOUT_MS = 5 * 60 * 1000;

/** Default virtual-camera device path. Overridable via `VELLUM_AVATAR_DEVICE`. */
const DEFAULT_AVATAR_DEVICE_PATH = "/dev/video10";

/** Env var the assistant reads to discover its virtual-camera device path. */
export const AVATAR_DEVICE_ENV_VAR = "VELLUM_AVATAR_DEVICE";

/**
 * Resolve the avatar device path from the environment. Always returns a
 * value — the CLI unconditionally passes the device path to the assistant
 * container; the skill decides whether to use it.
 */
export function resolveAvatarDevicePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[AVATAR_DEVICE_ENV_VAR];
  return override && override.length > 0
    ? override
    : DEFAULT_AVATAR_DEVICE_PATH;
}

/** Default memory (GiB) allocated to the Colima VM. */
const COLIMA_DEFAULT_MEMORY_GIB = 8;

/** Directory for user-local binary installs (no sudo required). */

const LOCAL_BIN_DIR = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".local",
  "bin",
);

/**
 * Returns the macOS architecture suffix used by GitHub release artifacts.
 * Maps Node's `arch()` values to the names used in release URLs.
 */
function releaseArch(): string {
  const a = arch();
  if (a === "arm64") return "aarch64";
  if (a === "x64") return "x86_64";
  return a;
}

/**
 * Downloads a file from `url` to `destPath`, makes it executable, and returns
 * the destination path. Throws on failure.
 */
async function downloadBinary(
  url: string,
  destPath: string,
  label: string,
): Promise<void> {
  console.log(`  ⬇ Downloading ${label}...`);
  await exec("bash", [
    "-c",
    `curl -fsSL -o "${destPath}" "${url}" && chmod +x "${destPath}"`,
  ]);
}

/**
 * Downloads and extracts a `.tar.gz` archive into `destDir`.
 */
async function downloadAndExtract(
  url: string,
  destDir: string,
  label: string,
): Promise<void> {
  console.log(`  ⬇ Downloading ${label}...`);
  await exec("bash", ["-c", `curl -fsSL "${url}" | tar xz -C "${destDir}"`]);
}

/**
 * Installs Docker CLI (and Colima + Lima on macOS) by downloading pre-built
 * binaries directly into ~/.local/bin/. No Homebrew or sudo required.
 */
async function installDockerToolchain(): Promise<void> {
  const isMac = platform() === "darwin";
  const isLinux = platform() === "linux";

  mkdirSync(LOCAL_BIN_DIR, { recursive: true });

  const cpuArch = releaseArch();

  if (isLinux) {
    // On Linux, Docker runs natively — only need the Docker CLI.
    console.log(
      "🐳 Docker not found. Installing Docker CLI to ~/.local/bin/...",
    );

    const dockerArch = cpuArch === "aarch64" ? "aarch64" : "x86_64";
    const dockerTarUrl = `https://download.docker.com/linux/static/stable/${dockerArch}/docker-27.5.1.tgz`;
    const dockerTmpDir = join(LOCAL_BIN_DIR, ".docker-tmp");
    mkdirSync(dockerTmpDir, { recursive: true });
    try {
      await downloadAndExtract(dockerTarUrl, dockerTmpDir, "Docker CLI");
      await exec("mv", [
        join(dockerTmpDir, "docker", "docker"),
        join(LOCAL_BIN_DIR, "docker"),
      ]);
      chmodSync(join(LOCAL_BIN_DIR, "docker"), 0o755);
    } finally {
      await exec("rm", ["-rf", dockerTmpDir]).catch(() => {});
    }

    if (!existsSync(join(LOCAL_BIN_DIR, "docker"))) {
      throw new Error(
        "docker binary not found after installation. Please install Docker manually: https://docs.docker.com/engine/install/",
      );
    }

    console.log("  ✅ Docker CLI installed to ~/.local/bin/");
    return;
  }

  if (!isMac) {
    throw new Error(
      "Automatic Docker installation is only supported on macOS and Linux. " +
        "Please install Docker manually: https://docs.docker.com/engine/install/",
    );
  }

  console.log(
    "🐳 Docker not found. Installing Docker, Colima, and Lima to ~/.local/bin/...",
  );

  // --- Docker CLI (macOS) ---
  // Docker publishes static binaries at download.docker.com.
  const dockerArch = cpuArch === "aarch64" ? "aarch64" : "x86_64";
  const dockerTarUrl = `https://download.docker.com/mac/static/stable/${dockerArch}/docker-27.5.1.tgz`;
  const dockerTmpDir = join(LOCAL_BIN_DIR, ".docker-tmp");
  mkdirSync(dockerTmpDir, { recursive: true });
  try {
    await downloadAndExtract(dockerTarUrl, dockerTmpDir, "Docker CLI");
    // The archive extracts to docker/docker — move it to our bin dir.
    await exec("mv", [
      join(dockerTmpDir, "docker", "docker"),
      join(LOCAL_BIN_DIR, "docker"),
    ]);
    chmodSync(join(LOCAL_BIN_DIR, "docker"), 0o755);
  } finally {
    await exec("rm", ["-rf", dockerTmpDir]).catch(() => {});
  }

  // --- Colima ---
  const colimaArch = cpuArch === "aarch64" ? "arm64" : "x86_64";
  const colimaUrl = `https://github.com/abiosoft/colima/releases/latest/download/colima-Darwin-${colimaArch}`;
  await downloadBinary(colimaUrl, join(LOCAL_BIN_DIR, "colima"), "Colima");

  // --- Lima ---
  // Lima publishes tar.gz archives with bin/limactl and other tools.
  const limaArch = cpuArch === "aarch64" ? "arm64" : "x86_64";
  const limaVersionUrl =
    "https://api.github.com/repos/lima-vm/lima/releases/latest";
  let limaVersion: string;
  try {
    const resp = await fetch(limaVersionUrl);
    if (!resp.ok) {
      throw new Error(
        `GitHub API returned ${resp.status}` +
          (resp.status === 403
            ? " (rate-limited) — try again later."
            : `. Check your network connection.`),
      );
    }
    const data = (await resp.json()) as { tag_name?: string };
    if (!data.tag_name) {
      throw new Error("GitHub API response missing tag_name.");
    }
    limaVersion = data.tag_name; // e.g. "v1.0.3"
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch latest Lima version: ${message}`);
  }
  const limaVersionNum = limaVersion.replace(/^v/, ""); // "1.0.3"
  const limaTarUrl = `https://github.com/lima-vm/lima/releases/download/${limaVersion}/lima-${limaVersionNum}-Darwin-${limaArch}.tar.gz`;
  // Lima archives contain bin/limactl, bin/lima, share/lima/..., so extract
  // into the parent (~/.local/) so that limactl lands in ~/.local/bin/.
  const localDir = dirname(LOCAL_BIN_DIR);
  await downloadAndExtract(limaTarUrl, localDir, "Lima");

  // Verify all binaries are in place.
  for (const bin of ["docker", "colima", "limactl"]) {
    if (!existsSync(join(LOCAL_BIN_DIR, bin))) {
      throw new Error(
        `${bin} binary not found after installation. Please install Docker manually.`,
      );
    }
  }

  console.log("  ✅ Docker toolchain installed to ~/.local/bin/");
}

/**
 * Ensures ~/.local/bin/ is on PATH for this process so that docker, colima,
 * and limactl are discoverable.
 */
function ensureLocalBinOnPath(): void {
  const currentPath = process.env.PATH || "";
  if (!currentPath.includes(LOCAL_BIN_DIR)) {
    process.env.PATH = `${LOCAL_BIN_DIR}:${currentPath}`;
  }
}

export interface HatchDockerParams {
  /** Assistant species to hatch (e.g. `"vellum"`). */
  species: Species;
  /** Run detached without attaching to logs or interactive setup. */
  detached?: boolean;
  /** Instance display name. Defaults to an auto-generated name. */
  name?: string | null;
  /** Build from a local source tree and hot-reload on change. */
  watch?: boolean;
  /** Hatch-time config values (key → value). */
  configValues?: Record<string, string>;
  /** Extra env vars forwarded into the assistant container. */
  flagEnvVars?: Record<string, string>;
  setupProviderCredentials?: boolean;
  /**
   * Path to a local source tree to build images from before hatching. When
   * provided, this path is used directly as the repo root and no file
   * watcher is started — useful for callers (e.g. evals) that want each
   * run to pick up local CLI changes without keeping a long-lived watcher
   * process around. `--watch` independently auto-detects the repo root and
   * also enables hot-reload.
   */
  sourcePath?: string | null;
  analyze?: boolean;
  /**
   * Name of an existing container whose network namespace the assistant,
   * gateway, and credential-executor join (`--network=container:<name>`),
   * instead of the assistant owning a freshly-created per-instance network.
   * When set, hatch creates no Docker network and publishes no host ports —
   * the namespace owner is responsible for publishing the gateway port — so
   * `gatewayPort` must also be supplied (the owner had to publish it before
   * hatch ran).
   */
  netnsContainer?: string;
  /**
   * Explicit host port to record as the gateway's `runtimeUrl` instead of
   * auto-allocating a free port. Required alongside `netnsContainer`, where
   * the namespace owner — not hatch — owns port allocation and publishing.
   */
  gatewayPort?: number;
  /**
   * Host path to a PEM CA bundle bind-mounted into the assistant container
   * and trusted at process start via `NODE_EXTRA_CA_CERTS`. Lets the daemon
   * trust a TLS-terminating egress proxy from its very first outbound
   * connection.
   */
  assistantCaCertPath?: string;
  /**
   * Release channel to resolve published images from when hatching without a
   * local source tree (the image-pull fallback). `stable` (default) keeps the
   * latest-stable behavior; `preview` pulls the latest preview release. Only
   * affects the pull path — a local source build ignores it. Falls back to
   * the `VELLUM_HATCH_CHANNEL` env var when unset, so callers that hatch via
   * env (e.g. evals) can opt in without changing the invocation.
   */
  channel?: ReleaseChannel;
}

export type DockerProviderCredentialSetupAction =
  | "configure"
  | "defer"
  | "missing-token"
  | "skip";

export function resolveDockerProviderCredentialSetupAction(options: {
  provider: string | null | undefined;
  guardianAccessToken?: string;
  detached: boolean;
}): DockerProviderCredentialSetupAction {
  if (options.provider === undefined) return "skip";
  if (options.provider === null) return options.detached ? "skip" : "configure";
  if (options.detached) return "defer";
  if (!options.guardianAccessToken) return "missing-token";
  return "configure";
}

/**
 * Checks whether the `docker` CLI and daemon are available on the system.
 * Installs Colima and Docker via direct binary download if missing (no sudo
 * required), and starts Colima if the Docker daemon is not reachable.
 */
async function ensureDockerInstalled(): Promise<void> {
  // Always add ~/.local/bin to PATH so previously installed binaries are found.
  ensureLocalBinOnPath();

  const isLinux = platform() === "linux";

  // On Linux, Docker runs natively — only need the docker CLI + daemon.
  // On macOS, we also need Colima and Lima to provide a Linux VM.
  const toolchainComplete = await (async () => {
    try {
      await execOutput("docker", ["--version"]);
      if (!isLinux) {
        await execOutput("colima", ["version"]);
        await execOutput("limactl", ["--version"]);
      }
      return true;
    } catch {
      return false;
    }
  })();

  if (!toolchainComplete) {
    await installDockerToolchain();
    // Re-check PATH after install.
    ensureLocalBinOnPath();

    try {
      await execOutput("docker", ["--version"]);
    } catch {
      throw new Error(
        "Docker was installed but is still not available on PATH. " +
          "You may need to restart your terminal.",
      );
    }
  }

  // Verify the Docker daemon is reachable.
  try {
    await exec("docker", ["info"]);
  } catch {
    // On Linux, the daemon must already be running (systemd, etc.).
    if (isLinux) {
      throw new Error(
        "Docker daemon is not running. Please start it with 'sudo systemctl start docker' " +
          "or ensure the Docker service is enabled.",
      );
    }

    // On macOS, try starting Colima.
    let hasColima = false;
    try {
      await execOutput("colima", ["version"]);
      hasColima = true;
    } catch {
      // colima not found
    }

    if (!hasColima) {
      throw new Error(
        "Docker daemon is not running and Colima is not installed.\n" +
          "Please start Docker Desktop, or install Colima with 'brew install colima' and run 'colima start'.",
      );
    }

    console.log("🚀 Docker daemon not running. Starting Colima...");
    try {
      await exec("colima", [
        "start",
        "--memory",
        String(COLIMA_DEFAULT_MEMORY_GIB),
      ]);
    } catch {
      // Colima may fail if a previous VM instance is in a corrupt state.
      // Attempt to delete the stale instance and retry once.
      console.log(
        "⚠️  Colima start failed — attempting to reset stale VM state...",
      );
      try {
        await exec("colima", ["stop", "--force"]).catch(() => {});
        await exec("colima", ["delete", "--force"]);
      } catch {
        // If delete also fails, fall through to the retry which will
        // produce a clear error message.
      }

      try {
        console.log("🔄 Retrying colima start...");
        await exec("colima", [
          "start",
          "--memory",
          String(COLIMA_DEFAULT_MEMORY_GIB),
        ]);
      } catch (retryErr) {
        const message =
          retryErr instanceof Error ? retryErr.message : String(retryErr);
        throw new Error(
          `Failed to start Colima after resetting stale VM state. Please run 'colima start' manually.\n${message}`,
        );
      }
    }
  }
}

/** Derive the Docker resource names from the instance name. */
export function dockerResourceNames(instanceName: string) {
  return {
    assistantContainer: `${instanceName}-assistant`,
    assistantIpcVolume: `${instanceName}-assistant-ipc`,
    cesContainer: `${instanceName}-credential-executor`,
    cesSecurityVolume: `${instanceName}-ces-sec`,
    gatewayContainer: `${instanceName}-gateway`,
    gatewayIpcVolume: `${instanceName}-gateway-ipc`,
    gatewaySecurityVolume: `${instanceName}-gateway-sec`,
    network: `${instanceName}-net`,
    socketVolume: `${instanceName}-socket`,
    workspaceVolume: `${instanceName}-workspace`,
  };
}

/** Silently attempt to stop and remove a Docker container. */
export async function removeContainer(containerName: string): Promise<void> {
  try {
    await exec("docker", ["stop", containerName]);
  } catch {
    // container may not exist or already stopped
  }
  try {
    await exec("docker", ["rm", containerName]);
  } catch {
    // container may not exist or already removed
  }
}

export async function retireDocker(name: string): Promise<void> {
  console.log(`\u{1F5D1}\ufe0f  Stopping Docker containers for '${name}'...\n`);

  // Stop the file watcher process if one is tracked for this instance.
  const entry = findAssistantByName(name);
  const watcherPid =
    typeof entry?.watcherPid === "number" ? entry.watcherPid : null;
  if (watcherPid !== null) {
    if (isVellumProcess(watcherPid)) {
      await stopProcess(watcherPid, "file-watcher");
    } else {
      console.log(
        `PID ${watcherPid} is not a vellum process — skipping stale file-watcher PID.`,
      );
    }
  }

  const res = dockerResourceNames(name);

  await removeContainer(res.cesContainer);
  await removeContainer(res.gatewayContainer);
  await removeContainer(res.assistantContainer);

  // Also clean up a legacy single-container instance if it exists
  await removeContainer(name);

  // Remove network and volumes
  try {
    await exec("docker", ["network", "rm", res.network]);
  } catch {
    // network may not exist
  }
  for (const vol of [
    res.socketVolume,
    res.assistantIpcVolume,
    res.gatewayIpcVolume,
    res.workspaceVolume,
    res.cesSecurityVolume,
    res.gatewaySecurityVolume,
  ]) {
    try {
      await exec("docker", ["volume", "rm", vol]);
    } catch {
      // volume may not exist
    }
  }

  // Future: consider stopping Colima VM when no Docker instances remain.
  // Considerations:
  // - Use loadAllAssistantsAcrossEnvs() instead of loadAllAssistants() to
  //   avoid stopping Colima while another VELLUM_ENVIRONMENT still has a
  //   running Docker instance.
  // - Track whether Vellum started Colima (vs. the user already had it
  //   running for non-Vellum workloads) \u2014 e.g. via a dedicated Colima
  //   profile (`colima start --profile vellum`) or a sentinel file.
  // - Only stop if both conditions are met: no cross-env Docker instances
  //   AND Vellum owns the Colima lifecycle.

  console.log(`\u2705 Docker instance retired.`);
}

/**
 * Walk up from `startDir` looking for a directory that contains
 * `assistant/Dockerfile`. Returns the path if found, otherwise `undefined`.
 */
function walkUpForRepoRoot(startDir: string): string | undefined {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, "assistant", "Dockerfile"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Returns `true` when the given root looks like a full source checkout
 * (has assistant source code), as opposed to a packaged `.app` bundle
 * that only contains the Dockerfiles.
 */
function hasFullSourceTree(root: string): boolean {
  return existsSync(join(root, "assistant", "package.json"));
}

/**
 * Decide which image-source path `hatchDocker` should take given the user
 * flags and a probe result for the source tree.
 *
 * - `watch` always wants source-build *and* file-watcher (when the source
 *   tree is available).
 * - `buildFromSource` wants source-build but no watcher — used by evals so
 *   each run picks up fresh CLI changes from the repo.
 * - Without either flag we pull the published images.
 * - If either flag was set but the source tree is missing (e.g. the CLI is
 *   running from a packaged .app bundle), fall back to pulling and surface
 *   the reason so the caller can log a warning.
 *
 * Returning a plain record keeps this trivially unit-testable — see
 * `__tests__/docker.test.ts`.
 */
export function resolveDockerHatchMode(opts: {
  watch: boolean;
  buildFromSource: boolean;
  fullSourceTreeAvailable: boolean;
}): { build: boolean; watcher: boolean; fellBackToPull: boolean } {
  const requested = opts.watch || opts.buildFromSource;
  if (!requested) {
    return { build: false, watcher: false, fellBackToPull: false };
  }
  if (!opts.fullSourceTreeAvailable) {
    return { build: false, watcher: false, fellBackToPull: true };
  }
  return { build: true, watcher: opts.watch, fellBackToPull: false };
}

/**
 * Locate the repository root by walking up from `cli/src/lib/` until we
 * find a directory containing the expected Dockerfiles.
 */
function findRepoRoot(): string {
  // cli/src/lib/ -> repo root (works when running from source via bun)
  const sourceTreeRoot = join(import.meta.dir, "..", "..", "..");
  if (existsSync(join(sourceTreeRoot, "assistant", "Dockerfile"))) {
    return sourceTreeRoot;
  }

  // Walk up from the compiled binary's location. When the CLI is bundled
  // inside the macOS app (e.g. .../dist/Vellum.app/Contents/MacOS/vellum-cli),
  // the binary still lives inside the repo tree, so walking up will
  // eventually reach the repo root.
  const execRoot = walkUpForRepoRoot(dirname(process.execPath));
  if (execRoot) {
    return execRoot;
  }

  // Check the app bundle's Resources directory. Debug DMG builds bundle
  // Dockerfiles at Contents/Resources/dockerfiles/{assistant,gateway,...}/Dockerfile.
  // The CLI binary lives at Contents/MacOS/vellum-cli, so Resources is at
  // ../Resources relative to the binary.
  const bundledRoot = join(
    dirname(process.execPath),
    "..",
    "Resources",
    "dockerfiles",
  );
  if (existsSync(join(bundledRoot, "assistant", "Dockerfile"))) {
    return bundledRoot;
  }

  // Walk up from cwd as a final fallback
  const cwdRoot = walkUpForRepoRoot(process.cwd());
  if (cwdRoot) {
    return cwdRoot;
  }

  throw new Error(
    "Could not find repository root containing assistant/Dockerfile. " +
      "Run this command from within the vellum-assistant repository.",
  );
}

interface ServiceImageConfig {
  context: string;
  dockerfile: string;
  tag: string;
}

async function buildImage(config: ServiceImageConfig): Promise<void> {
  await exec(
    "docker",
    ["build", "-f", config.dockerfile, "-t", config.tag, "."],
    { cwd: config.context },
  );
}

function serviceImageConfigs(
  repoRoot: string,
  imageTags: Record<ServiceName, string>,
): Record<ServiceName, ServiceImageConfig> {
  return {
    assistant: {
      context: repoRoot,
      dockerfile: "assistant/Dockerfile",
      tag: imageTags.assistant,
    },
    "credential-executor": {
      context: repoRoot,
      dockerfile: "credential-executor/Dockerfile",
      tag: imageTags["credential-executor"],
    },
    gateway: {
      context: repoRoot,
      dockerfile: "gateway/Dockerfile",
      tag: imageTags.gateway,
    },
  };
}

async function buildAllImages(
  repoRoot: string,
  imageTags: Record<ServiceName, string>,
  log: (msg: string) => void,
): Promise<void> {
  const configs = serviceImageConfigs(repoRoot, imageTags);
  log("🔨 Building all images in parallel...");
  await Promise.all(
    Object.entries(configs).map(async ([name, config]) => {
      await buildImage(config);
      log(`✅ ${name} built`);
    }),
  );
}

/** The order in which services must be started. */
export const SERVICE_START_ORDER: ServiceName[] = [
  "assistant",
  "gateway",
  "credential-executor",
];

/** Start all three containers in dependency order. */
export async function startContainers(
  opts: {
    signingKey?: string;
    bootstrapSecret?: string;
    cesServiceToken?: string;
    extraAssistantEnv?: Record<string, string>;
    extraGatewayEnv?: Record<string, string>;
    gatewayPort: number;
    assistantPort: number;
    imageTags: Record<ServiceName, string>;
    instanceName: string;
    res: ReturnType<typeof dockerResourceNames>;
    netnsContainer?: string;
    assistantCaCertPath?: string;
  },
  log: (msg: string) => void,
): Promise<void> {
  const runArgs = buildServiceRunArgs({
    ...opts,
    avatarDevicePath: resolveAvatarDevicePath(),
  });
  for (const service of SERVICE_START_ORDER) {
    log(`🚀 Starting ${service} container...`);
    await exec("docker", runArgs[service]());
  }
}

/** Stop and remove all three containers (ignoring errors). */
export async function stopContainers(
  res: ReturnType<typeof dockerResourceNames>,
): Promise<void> {
  await removeContainer(res.cesContainer);
  await removeContainer(res.gatewayContainer);
  await removeContainer(res.assistantContainer);
}

/** Stop containers without removing them (preserves state for `docker start`). */
export async function sleepContainers(
  res: ReturnType<typeof dockerResourceNames>,
): Promise<void> {
  for (const container of [
    res.cesContainer,
    res.gatewayContainer,
    res.assistantContainer,
  ]) {
    try {
      await exec("docker", ["stop", container]);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message.toLowerCase() : String(err);
      if (msg.includes("no such container") || msg.includes("is not running")) {
        // container doesn't exist or already stopped — expected, skip
        continue;
      }
      throw err;
    }
  }
}

/** Start existing stopped containers, starting Colima first if it isn't running (macOS only). */
export async function wakeContainers(
  res: ReturnType<typeof dockerResourceNames>,
): Promise<void> {
  if (platform() !== "linux") {
    await ensureColimaRunning();
  }
  for (const container of [
    res.assistantContainer,
    res.gatewayContainer,
    res.cesContainer,
  ]) {
    await exec("docker", ["start", container]);
  }
}

/**
 * Checks whether Colima is running and starts it if not.
 * Assumes the Docker/Colima toolchain is already installed (handled during hatch).
 */
async function ensureColimaRunning(): Promise<void> {
  ensureLocalBinOnPath();
  try {
    await exec("colima", ["status"]);
  } catch {
    console.log("🚀 Colima is not running. Starting Colima...");
    await exec("colima", ["start"]);
  }
}

/**
 * Capture the current image references for running service containers.
 * Returns a complete record of service → immutable image ID (sha256 digest)
 * for all three services. Uses `{{.Image}}` rather than `{{.Config.Image}}`
 * so rollback targets the exact image that was running, even if the tag has
 * since been retagged to a different image.
 *
 * Returns null if any container could not be inspected (e.g. fresh install
 * or partial deployment).
 */
export async function captureImageRefs(
  res: ReturnType<typeof dockerResourceNames>,
): Promise<Record<ServiceName, string> | null> {
  const containerForService: Record<ServiceName, string> = {
    assistant: res.assistantContainer,
    "credential-executor": res.cesContainer,
    gateway: res.gatewayContainer,
  };

  const refs: Partial<Record<ServiceName, string>> = {};

  for (const [service, container] of Object.entries(containerForService)) {
    try {
      const imageRef = (
        await execOutput("docker", [
          "inspect",
          "--format",
          "{{.Image}}",
          container,
        ])
      ).trim();
      if (imageRef) {
        refs[service as ServiceName] = imageRef;
      }
    } catch {
      // Container doesn't exist or can't be inspected — skip
    }
  }

  const allServices: ServiceName[] = [
    "assistant",
    "credential-executor",
    "gateway",
  ];
  const hasAll = allServices.every((s) => s in refs);
  return hasAll ? (refs as Record<ServiceName, string>) : null;
}

/**
 * Build the set of paths the hot-reload watcher should observe, scoped to
 * each service's `src/` tree, `package.json` manifest, and `Dockerfile`.
 *
 * We deliberately avoid recursively watching whole service directories.
 * Those contain `.claude/` command symlinks — which dangle in a fresh
 * checkout because they point at the separately-cloned `claude-skills`
 * repo — as well as `node_modules`. `fs.watch(dir, { recursive: true })`
 * traverses those entries and emits an unhandled `error` event on a broken
 * symlink, which crashes the CLI process. Source code only ever lives under
 * `src/`, so watching that tree plus the two manifests that drive the image
 * build (`package.json` and `Dockerfile`) preserves hot-reload without
 * walking into symlinked or generated trees. The `Dockerfile` is watched as
 * an individual file for the same reason — editing build steps should
 * trigger a rebuild, but the file sits next to the symlinked trees we avoid.
 *
 * Returning a plain record keeps this trivially unit-testable — see
 * `__tests__/docker.test.ts`.
 */
export function collectWatchTargets(repoRoot: string): {
  dirs: string[];
  files: string[];
} {
  const packagesDir = join(repoRoot, "packages");
  const packageRoots = existsSync(packagesDir)
    ? readdirSync(packagesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(packagesDir, entry.name))
    : [];

  const serviceRoots = [
    join(repoRoot, "assistant"),
    join(repoRoot, "credential-executor"),
    join(repoRoot, "gateway"),
    ...packageRoots,
  ];

  const dirs: string[] = [];
  const files: string[] = [];
  for (const root of serviceRoots) {
    const srcDir = join(root, "src");
    if (existsSync(srcDir)) dirs.push(srcDir);
    for (const name of ["package.json", "Dockerfile"]) {
      const file = join(root, name);
      if (existsSync(file)) files.push(file);
    }
  }
  return { dirs, files };
}

/**
 * Determine which services are affected by a changed file path relative
 * to the repository root.
 */
function affectedServices(
  filePath: string,
  repoRoot: string,
): Set<ServiceName> {
  const rel = filePath.startsWith(repoRoot)
    ? filePath.slice(repoRoot.length + 1)
    : filePath;

  const affected = new Set<ServiceName>();

  if (rel.startsWith("assistant/")) {
    affected.add("assistant");
  }
  if (rel.startsWith("credential-executor/")) {
    affected.add("credential-executor");
  }
  if (rel.startsWith("gateway/")) {
    affected.add("gateway");
  }
  // Shared packages affect both assistant and credential-executor
  if (rel.startsWith("packages/")) {
    affected.add("assistant");
    affected.add("credential-executor");
  }

  return affected;
}

/**
 * Watch for source changes across the assistant, gateway, credential-executor,
 * and packages services — scoped to each service's `src/` tree, `package.json`,
 * and `Dockerfile` (see `collectWatchTargets`). When changes are detected,
 * rebuild the affected images and restart their containers.
 */
function startFileWatcher(opts: {
  signingKey?: string;
  bootstrapSecret?: string;
  cesServiceToken?: string;
  extraAssistantEnv?: Record<string, string>;
  extraGatewayEnv?: Record<string, string>;
  gatewayPort: number;
  assistantPort: number;
  imageTags: Record<ServiceName, string>;
  instanceName: string;
  repoRoot: string;
  res: ReturnType<typeof dockerResourceNames>;
  netnsContainer?: string;
  assistantCaCertPath?: string;
}): () => void {
  const { gatewayPort, assistantPort, imageTags, instanceName, repoRoot, res } = opts;

  const { dirs: watchDirs, files: watchFiles } = collectWatchTargets(repoRoot);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingServices = new Set<ServiceName>();
  let rebuilding = false;

  const configs = serviceImageConfigs(repoRoot, imageTags);
  const runArgs = buildServiceRunArgs({
    signingKey: opts.signingKey,
    bootstrapSecret: opts.bootstrapSecret,
    cesServiceToken: opts.cesServiceToken,
    extraAssistantEnv: opts.extraAssistantEnv,
    extraGatewayEnv: opts.extraGatewayEnv,
    gatewayPort,
    assistantPort,
    imageTags,
    instanceName,
    res,
    avatarDevicePath: resolveAvatarDevicePath(),
    netnsContainer: opts.netnsContainer,
    assistantCaCertPath: opts.assistantCaCertPath,
  });
  const containerForService: Record<ServiceName, string> = {
    assistant: res.assistantContainer,
    "credential-executor": res.cesContainer,
    gateway: res.gatewayContainer,
  };

  async function rebuildAndRestart(): Promise<void> {
    if (rebuilding) return;
    rebuilding = true;

    const services = pendingServices;
    pendingServices = new Set();

    // Gateway and CES share the assistant's network namespace. If the
    // assistant container is removed and recreated, the shared namespace
    // is destroyed and the other two lose connectivity. Cascade the
    // restart to all three services in that case.
    if (services.has("assistant")) {
      services.add("gateway");
      services.add("credential-executor");
    }

    const serviceNames = [...services].join(", ");
    console.log(`\n🔄 Changes detected — rebuilding: ${serviceNames}`);

    try {
      await Promise.all(
        [...services].map(async (service) => {
          console.log(`🔨 Building ${service}...`);
          await buildImage(configs[service]);
          console.log(`✅ ${service} built`);
        }),
      );

      // Restart in dependency order (assistant first) so the network
      // namespace owner is up before dependents try to attach.
      for (const service of SERVICE_START_ORDER) {
        if (!services.has(service)) continue;
        const container = containerForService[service];
        console.log(`🔄 Restarting ${container}...`);
        await removeContainer(container);
        await exec("docker", runArgs[service]());
      }

      console.log("✅ Rebuild complete — watching for changes...\n");
    } catch (err) {
      console.error(
        `❌ Rebuild failed: ${err instanceof Error ? err.message : err}`,
      );
      console.log("   Watching for changes...\n");
    } finally {
      rebuilding = false;
      if (pendingServices.size > 0) {
        rebuildAndRestart();
      }
    }
  }

  const watchers: ReturnType<typeof fsWatch>[] = [];

  function onChange(fullPath: string): void {
    const services = affectedServices(fullPath, repoRoot);
    if (services.size === 0) return;

    for (const s of services) {
      pendingServices.add(s);
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      rebuildAndRestart();
    }, 500);
  }

  for (const dir of watchDirs) {
    const watcher = fsWatch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (filename.includes("node_modules") || filename.includes(".env")) {
        return;
      }
      onChange(join(dir, filename));
    });
    // fs.watch surfaces transient errors (e.g. an unreadable entry) as an
    // `error` event, which would otherwise crash the process. Log and keep
    // the remaining watchers running.
    watcher.on("error", (err) => {
      console.error(
        `⚠️  File watcher error for ${dir}: ${err instanceof Error ? err.message : err}`,
      );
    });
    watchers.push(watcher);
  }

  for (const file of watchFiles) {
    const watcher = fsWatch(file, () => onChange(file));
    watcher.on("error", (err) => {
      console.error(
        `⚠️  File watcher error for ${file}: ${err instanceof Error ? err.message : err}`,
      );
    });
    watchers.push(watcher);
  }

  console.log("👀 Watching for file changes in:");
  console.log("   <service>/src, <service>/package.json, <service>/Dockerfile");
  console.log("   for assistant/, gateway/, credential-executor/, packages/*");
  console.log("");

  return () => {
    for (const watcher of watchers) {
      watcher.close();
    }
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}

export async function hatchDocker(params: HatchDockerParams): Promise<void> {
  const {
    species,
    detached = false,
    name = null,
    configValues = {},
    flagEnvVars = {},
  } = params;
  let watch = params.watch ?? false;
  // Resolve the release channel for the image-pull fallback: explicit param
  // wins, then the VELLUM_HATCH_CHANNEL env var, else stable. Any value other
  // than "preview" (case-insensitive) is treated as stable.
  const channel: ReleaseChannel =
    params.channel ??
    (process.env.VELLUM_HATCH_CHANNEL?.trim().toLowerCase() === "preview"
      ? "preview"
      : "stable");

  resetLogFile("hatch.log");
  const provider =
    params.setupProviderCredentials === false
      ? undefined
      : resolveHatchProvider(configValues);

  let logFd = openLogFile("hatch.log");
  const log = (msg: string): void => {
    console.log(msg);
    writeToLogFile(logFd, `${new Date().toISOString()} ${msg}\n`);
  };

  try {
    emitProgress(1, 6, "Checking Docker...");
    await ensureDockerInstalled();

    const instanceName = generateInstanceName(species, name);
    // Resolve the gateway's host port. When joining an externally-owned
    // network namespace, the owner has already published the gateway port,
    // so the caller — not hatch — owns port allocation; use the supplied
    // port verbatim. Otherwise resolve it dynamically: the env-default
    // (production 7830 / non-prod overrides) is just the *preferred*
    // starting point — if it's taken by another local assistant, eval run,
    // or unrelated process, we walk upward until we find a free port, so
    // concurrent instances don't collide on a docker bind error.
    let gatewayPort: number;
    if (params.netnsContainer) {
      if (params.gatewayPort === undefined) {
        throw new Error(
          "hatchDocker: gatewayPort is required when netnsContainer is set (the namespace owner publishes the port before hatch runs)",
        );
      }
      gatewayPort = params.gatewayPort;
    } else {
      const preferredGatewayPort = getDefaultPorts(
        getCurrentEnvironment(),
      ).gateway;
      gatewayPort = await findOpenPort(preferredGatewayPort);
      if (gatewayPort !== preferredGatewayPort) {
        log(
          `Preferred gateway port ${preferredGatewayPort} is in use; allocated ${gatewayPort} for this instance.`,
        );
      }
    }

    // Allocate the assistant HTTP API host port. Same dynamic-allocation
    // strategy as the gateway port: the env-default (production 7821 /
    // non-prod overrides) is the *preferred* starting point, and we walk
    // upward until we find a free port. Without this, two concurrent
    // `vellum hatch --remote docker` on the same host collide on a fixed
    // 7821 bind ("port is already allocated"). Unused when netnsContainer
    // is set — no host ports are published in that mode.
    let assistantPort: number;
    if (params.netnsContainer) {
      assistantPort = ASSISTANT_INTERNAL_PORT;
    } else {
      const preferredAssistantPort = getDefaultPorts(
        getCurrentEnvironment(),
      ).daemon;
      assistantPort = await findOpenPort(preferredAssistantPort, {
        exclude: [gatewayPort],
      });
      if (assistantPort !== preferredAssistantPort) {
        log(
          `Preferred assistant port ${preferredAssistantPort} is in use; allocated ${assistantPort} for this instance.`,
        );
      }
    }

    const imageTags: Record<ServiceName, string> = {
      assistant: "",
      "credential-executor": "",
      gateway: "",
    };

    const sourcePath =
      typeof params.sourcePath === "string" && params.sourcePath.length > 0
        ? params.sourcePath
        : null;
    const buildFromSource = sourcePath !== null;
    let repoRoot: string | undefined;
    let fullSourceTreeAvailable = false;

    if (watch || buildFromSource) {
      // When --source <path> is supplied, trust the caller and use it
      // directly. Otherwise (the --watch case) walk up from known locations
      // to find the repo root.
      repoRoot = sourcePath ? resolve(sourcePath) : findRepoRoot();

      // When running from a packaged .app bundle, the Dockerfiles are
      // present (so findRepoRoot succeeds) but the full source tree is
      // not — we can't build images locally. Fall back to pulling
      // pre-built images instead.
      fullSourceTreeAvailable = hasFullSourceTree(repoRoot);
      if (!fullSourceTreeAvailable) {
        log(
          "⚠️  Dockerfiles found but no source tree — falling back to image pull",
        );
        repoRoot = undefined;
      }
    }

    const mode = resolveDockerHatchMode({
      watch,
      buildFromSource,
      fullSourceTreeAvailable,
    });
    // Honour the resolved mode for the rest of the flow.
    watch = mode.watcher;

    if (mode.build && repoRoot) {
      emitProgress(2, 6, "Building images...");
      const localTag = `local-${instanceName}`;
      imageTags.assistant = `vellum-assistant:${localTag}`;
      imageTags.gateway = `vellum-gateway:${localTag}`;
      imageTags["credential-executor"] =
        `vellum-credential-executor:${localTag}`;

      log(`🥚 Hatching Docker assistant: ${instanceName}`);
      log(`   Species: ${species}`);
      log(
        `   Mode: ${mode.watcher ? "development (watch)" : "build-from-source"}`,
      );
      log(`   Repo: ${repoRoot}`);
      log(`   Images (local build):`);
      log(`     assistant:            ${imageTags.assistant}`);
      log(`     gateway:              ${imageTags.gateway}`);
      log(`     credential-executor:  ${imageTags["credential-executor"]}`);
      log("");

      await buildAllImages(repoRoot, imageTags, log);
      log("✅ Docker images built");
    }

    if (!mode.build || !repoRoot) {
      emitProgress(2, 6, "Pulling images...");

      // Allow explicit image overrides via environment variables.
      // When all three are set, skip version-based resolution entirely.
      const envAssistant = process.env.VELLUM_ASSISTANT_IMAGE;
      const envGateway = process.env.VELLUM_GATEWAY_IMAGE;
      const envCredentialExecutor =
        process.env.VELLUM_CREDENTIAL_EXECUTOR_IMAGE;

      let imageSource: string;

      if (envAssistant && envGateway && envCredentialExecutor) {
        imageTags.assistant = envAssistant;
        imageTags.gateway = envGateway;
        imageTags["credential-executor"] = envCredentialExecutor;
        imageSource = "env override";
        log("Using image overrides from environment variables");
      } else {
        // Resolve image refs from a remote source that may have dev/local
        // builds. If resolution is unavailable, fall back to the CLI's own
        // version so a default tag can still be resolved.
        log(`🔍 Fetching latest ${channel} release...`);
        const latestVersion = await fetchLatestVersion(channel);
        let versionTag: string;
        if (latestVersion) {
          versionTag = latestVersion.startsWith("v")
            ? latestVersion
            : `v${latestVersion}`;
        } else {
          const fallback = cliPkg.version;
          versionTag = fallback ? `v${fallback}` : "latest";
          log(
            `⚠️  Platform releases unavailable; falling back to CLI version ${versionTag}`,
          );
        }
        log("🔍 Resolving image references...");
        const resolved = await resolveImageRefs(versionTag, log, channel);
        imageTags.assistant = resolved.imageTags.assistant;
        imageTags.gateway = resolved.imageTags.gateway;
        imageTags["credential-executor"] =
          resolved.imageTags["credential-executor"];
        imageSource = resolved.source;
      }

      log(`🥚 Hatching Docker assistant: ${instanceName}`);
      log(`   Species: ${species}`);
      log(`   Images (${imageSource}):`);
      log(`     assistant:            ${imageTags.assistant}`);
      log(`     gateway:              ${imageTags.gateway}`);
      log(`     credential-executor:  ${imageTags["credential-executor"]}`);
      log("");

      // Per-ref branching: local-build refs need the image-loader; external
      // registry refs get a normal `docker pull`. The two transports compose
      // cleanly — a release can mix different sources for different images.
      log("📦 Acquiring Docker images...");
      for (const service of [
        "assistant",
        "gateway",
        "credential-executor",
      ] as const) {
        const ref = imageTags[service];
        if (isLocalBuildRef(ref)) {
          log(`   ↪ loading ${ref} via host image-loader`);
          await loadImageViaHost(HOST_IMAGE_LOADER_URL, ref, log);
        } else {
          log(`   ↪ pulling ${ref}`);
          const MAX_PULL_RETRIES = 3;
          for (let attempt = 1; attempt <= MAX_PULL_RETRIES; attempt++) {
            try {
              await exec("docker", ["pull", ref]);
              break;
            } catch (err) {
              if (attempt === MAX_PULL_RETRIES) throw err;
              const delaySec = 2 ** attempt;
              log(
                `   ⚠ pull failed (attempt ${attempt}/${MAX_PULL_RETRIES}), retrying in ${delaySec}s...`,
              );
              await new Promise((r) => setTimeout(r, delaySec * 1000));
            }
          }
        }
      }
      log("✅ Docker images acquired");
    }

    const res = dockerResourceNames(instanceName);

    emitProgress(3, 6, "Creating volumes...");
    // When joining an externally-owned network namespace, the owner already
    // provides the network stack — creating a per-instance network here would
    // be unused and leak on teardown.
    if (params.netnsContainer) {
      log("📁 Joining existing network namespace; creating volumes...");
    } else {
      log("📁 Creating network and volumes...");
      await exec("docker", ["network", "create", res.network]);
    }
    await exec("docker", ["volume", "create", res.socketVolume]);
    await exec("docker", ["volume", "create", res.assistantIpcVolume]);
    await exec("docker", ["volume", "create", res.gatewayIpcVolume]);
    await exec("docker", ["volume", "create", res.workspaceVolume]);
    await exec("docker", ["volume", "create", res.cesSecurityVolume]);
    await exec("docker", ["volume", "create", res.gatewaySecurityVolume]);

    // Set volume ownership so non-root containers (UID 1001) can write.
    await exec("docker", [
      "run",
      "--rm",
      "-v",
      `${res.workspaceVolume}:/workspace`,
      "-v",
      `${res.assistantIpcVolume}:/run/assistant-ipc`,
      "-v",
      `${res.gatewayIpcVolume}:/run/gateway-ipc`,
      "busybox",
      "sh",
      "-c",
      "chown 1001:1001 /workspace /run/assistant-ipc /run/gateway-ipc",
    ]);

    // Stage the BYOK default-workspace-config overlay *inside* the workspace
    // volume so the daemon's startup loader can consume it. The loader
    // (`mergeDefaultWorkspaceConfig` in assistant/src/config/loader.ts) does:
    //   1. JSON.parse + deep-merge into the workspace's config.json.
    //   2. `renameSync(defaultConfigPath, <workspace>/default-config.json)`
    //      to mark the overlay consumed so subsequent restarts skip it.
    //
    // The rename must be same-filesystem. Bind-mounting the host file into
    // `/tmp/...` (the pre-#32025 design) crossed filesystems and silently
    // failed with EXDEV, so every `docker start` re-applied the overlay.
    // Staging into the workspace volume keeps the rename in-place.
    //
    // Streaming the JSON via stdin (instead of bind-mounting the host file
    // into the staging container) sidesteps macOS Colima's virtiofs share,
    // which doesn't expose `/var/folders/...` (where `os.tmpdir()` resolves
    // on macOS) and would otherwise materialize an empty directory at the
    // bind-mount target.
    //
    // @deprecated stopgap. Replacement direction is one of:
    //   1. Post-hatch API calls (POST /v1/secrets + a small endpoint that
    //      returns canonical inference-profile templates).
    //   2. Move inference-profile seeds out of workspace config and into
    //      Assistant code, eliminating the overlay entirely.
    // See `cli/src/lib/config-utils.ts` JSDoc for context.
    const hatchConfigValues = buildHatchConfigValues(configValues, provider);
    const hostOverlayPath = writeInitialConfig(hatchConfigValues);
    const stagedOverlayInContainer = "/workspace/.default-config-overlay.json";
    const extraAssistantEnv: Record<string, string> = {};
    if (hostOverlayPath) {
      await execWithStdin(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "-v",
          `${res.workspaceVolume}:/workspace`,
          "busybox",
          "sh",
          "-c",
          `cat > ${stagedOverlayInContainer} && chown 1001:1001 ${stagedOverlayInContainer}`,
        ],
        readFileSync(hostOverlayPath, "utf-8"),
      );
      extraAssistantEnv.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH =
        stagedOverlayInContainer;
    }

    const cesServiceToken = randomBytes(32).toString("hex");
    const signingKey = randomBytes(32).toString("hex");

    // When launched by a remote hatch startup script, the env var
    // GUARDIAN_BOOTSTRAP_SECRET is already set with the laptop's secret.
    // Generate a new secret for the local docker hatch caller and append
    // it so the gateway receives a comma-separated list of all expected
    // bootstrap secrets.
    const ownSecret = randomBytes(32).toString("hex");
    const preExisting = process.env.GUARDIAN_BOOTSTRAP_SECRET;
    const bootstrapSecret = preExisting
      ? `${preExisting},${ownSecret}`
      : ownSecret;

    emitProgress(4, 6, "Starting containers...");
    if (flagEnvVars.VELLUM_DISABLE_PLATFORM) {
      extraAssistantEnv.VELLUM_DISABLE_PLATFORM =
        flagEnvVars.VELLUM_DISABLE_PLATFORM;
    }
    const hostDeviceId = getOrCreateHostDeviceId();
    extraAssistantEnv.VELLUM_DEVICE_ID = hostDeviceId;
    const extraGatewayEnv = {
      ...flagEnvVars,
      VELLUM_DEVICE_ID: hostDeviceId,
    };
    await startContainers(
      {
        signingKey,
        bootstrapSecret,
        cesServiceToken,
        extraAssistantEnv,
        extraGatewayEnv,
        gatewayPort,
        assistantPort,
        imageTags,
        instanceName,
        res,
        netnsContainer: params.netnsContainer,
        assistantCaCertPath: params.assistantCaCertPath,
      },
      log,
    );
    const containersUpAt = Date.now();

    const imageDigests = await captureImageRefs(res);

    const runtimeUrl = `http://localhost:${gatewayPort}`;
    const dockerEntry: AssistantEntry = {
      assistantId: instanceName,
      runtimeUrl,
      cloud: "docker",
      species,
      hatchedAt: new Date().toISOString(),
      guardianBootstrapSecret: ownSecret,
      containerInfo: {
        assistantImage: imageTags.assistant,
        gatewayImage: imageTags.gateway,
        cesImage: imageTags["credential-executor"],
        assistantDigest: imageDigests?.assistant,
        gatewayDigest: imageDigests?.gateway,
        cesDigest: imageDigests?.["credential-executor"],
        networkName: res.network,
        assistantPort,
      },
    };
    emitProgress(5, 6, "Saving configuration...");
    saveAssistantEntry(dockerEntry);
    setActiveAssistant(instanceName);

    emitProgress(6, 6, "Waiting for services...");
    const waitDetached = watch ? false : detached;
    const { ready, guardianAccessToken } = await waitForGatewayAndLease({
      bootstrapSecret: ownSecret,
      containerName: res.assistantContainer,
      detached: waitDetached,
      instanceName,
      logFd,
      runtimeUrl,
      containersUpAt,
      analyze: params.analyze ?? false,
    });

    if (!ready && !(watch && repoRoot)) {
      throw new Error("Timed out waiting for assistant to become ready");
    }

    if (ready) {
      const providerSetupAction = resolveDockerProviderCredentialSetupAction({
        provider,
        guardianAccessToken,
        detached: waitDetached,
      });

      if (providerSetupAction === "defer" && provider !== null) {
        log(
          `Provider credential setup deferred in detached mode.\n` +
            `Run \`vellum setup --provider ${provider}\` after the assistant is ready.`,
        );
      } else if (providerSetupAction === "missing-token" && provider !== null) {
        log(
          `⚠️  Provider credential setup skipped because the guardian token was not leased.\n` +
            `   The assistant is still hatched. Run \`vellum setup --provider ${provider}\` after fixing the connection.`,
        );
      } else if (
        providerSetupAction === "configure" &&
        provider !== undefined
      ) {
        log(
          provider === null
            ? "Checking provider credentials..."
            : `Checking ${formatProviderName(provider)} credentials...`,
        );
        await configureHatchProviderApiKey({
          gatewayUrl: runtimeUrl,
          provider,
          bearerToken: guardianAccessToken,
          env: process.env,
          log,
        });
      }
      logHatchNextSteps(log, instanceName);
    }

    if (watch && repoRoot) {
      saveAssistantEntry({ ...dockerEntry, watcherPid: process.pid });

      const stopWatcher = startFileWatcher({
        signingKey,
        bootstrapSecret,
        cesServiceToken,
        extraAssistantEnv,
        extraGatewayEnv,
        gatewayPort,
        assistantPort,
        imageTags,
        instanceName,
        repoRoot,
        res,
        netnsContainer: params.netnsContainer,
        assistantCaCertPath: params.assistantCaCertPath,
      });

      await new Promise<void>((resolve) => {
        const cleanup = async () => {
          log("\n🛑 Shutting down...");
          stopWatcher();
          await stopContainers(res);
          saveAssistantEntry({ ...dockerEntry, watcherPid: undefined });
          log("✅ Docker instance stopped.");
          resolve();
        };

        // SIGINT (Ctrl+C): full cleanup including stopping containers.
        process.on("SIGINT", () => void cleanup());

        // SIGTERM (from `vellum retire`): exit quickly — the caller
        // handles container teardown, so we only need to close the
        // file watchers and let the process terminate.
        process.on("SIGTERM", () => {
          stopWatcher();
          saveAssistantEntry({ ...dockerEntry, watcherPid: undefined });
          resolve();
        });
      });
    }
  } finally {
    closeLogFile(logFd);
    logFd = "ignore";
  }
}

/**
 * In detached mode, print instance details and return immediately.
 * Otherwise, poll the gateway health check until it responds, then
 * lease a guardian token.
 */
async function waitForGatewayAndLease(opts: {
  bootstrapSecret: string;
  containerName: string;
  detached: boolean;
  instanceName: string;
  logFd: number | "ignore";
  runtimeUrl: string;
  containersUpAt: number;
  analyze: boolean;
}): Promise<{ ready: boolean; guardianAccessToken?: string }> {
  const {
    bootstrapSecret,
    containerName,
    detached,
    instanceName,
    logFd,
    runtimeUrl,
    containersUpAt,
    analyze,
  } = opts;

  const log = (msg: string): void => {
    console.log(msg);
    writeToLogFile(logFd, `${new Date().toISOString()} ${msg}\n`);
  };

  if (detached) {
    log("\n✅ Docker assistant hatched!\n");
    log("Instance details:");
    log(`  Name: ${instanceName}`);
    log(`  Runtime: ${runtimeUrl}`);
    log(`  Container: ${containerName}`);
    log("");
    log(`Stop with: vellum retire ${instanceName}`);

    // Lease a guardian token even in detached mode so that `vellum ps`,
    // `vellum exec`, and other CLI commands can authenticate to the
    // gateway. Skip the /readyz readiness poll (the caller asked to detach
    // and not block) but retry the lease itself since the gateway may need
    // a moment to accept connections after the container starts.
    const leaseStart = Date.now();
    const leaseDeadline = containersUpAt + DOCKER_READY_TIMEOUT_MS;
    let guardianAccessToken: string | undefined;
    while (Date.now() < leaseDeadline) {
      try {
        const tokenData = await leaseGuardianToken(
          runtimeUrl,
          instanceName,
          bootstrapSecret,
        );
        guardianAccessToken = tokenData.accessToken;
        const leaseElapsed = ((Date.now() - leaseStart) / 1000).toFixed(1);
        log(
          `Guardian token lease: success after ${leaseElapsed}s (principalId=${tokenData.guardianPrincipalId})`,
        );
        break;
      } catch (err) {
        const elapsed = ((Date.now() - leaseStart) / 1000).toFixed(0);
        const msg = err instanceof Error ? err.message : String(err);
        log(
          `Guardian token lease: attempt failed after ${elapsed}s (${msg.split("\n")[0]}), retrying...`,
        );
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!guardianAccessToken) {
      log(
        `⚠️  Guardian token lease failed after ${DOCKER_READY_TIMEOUT_MS / 1000}s.\n` +
          `   The assistant is running but CLI commands (vellum ps, vellum exec) will not authenticate.\n` +
          `   Re-hatch or run \`vellum setup\` to recover.`,
      );
    }
    return { ready: true, guardianAccessToken };
  }

  log(`  Container: ${containerName}`);
  log(`  Runtime: ${runtimeUrl}`);
  log("");
  log("Waiting for assistant to become ready...");

  const readyUrl = `${runtimeUrl}/readyz`;
  const start = containersUpAt;
  let ready = false;

  while (Date.now() - start < DOCKER_READY_TIMEOUT_MS) {
    try {
      const resp = await loopbackSafeFetch(readyUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        ready = true;
        break;
      }
      const body = await resp.text();
      let detail = "";
      try {
        const json = JSON.parse(body);
        const parts = [json.status];
        if (json.upstream != null) parts.push(`upstream=${json.upstream}`);
        detail = ` — ${parts.join(", ")}`;
      } catch {}
      log(`Readiness check: ${resp.status}${detail} (retrying...)`);
    } catch {
      // Connection refused / timeout — not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!ready) {
    log("");
    log(`   \u26a0\ufe0f  Timed out waiting for assistant to become ready.`);
    log(`   The container is still running.`);
    log(`   Check logs with: docker logs -f ${containerName}`);
    log("");
    return { ready: false };
  }

  const readyAt = Date.now();
  const containersUpToReadyMs = readyAt - start;
  const elapsedSec = (containersUpToReadyMs / 1000).toFixed(1);
  log(`Assistant ready after ${elapsedSec}s`);
  if (analyze) {
    console.info(
      `[vellum-hatch-timing] ${JSON.stringify({
        containers_up_to_ready_ms: containersUpToReadyMs,
        instance: instanceName,
      })}`,
    );
  }

  // Lease guardian token. The /readyz check confirms both gateway and
  // assistant are reachable. Retry with backoff in case there is a brief
  // window where readiness passes but the guardian endpoint is not yet ready.
  log(`Guardian token lease: starting for ${instanceName} at ${runtimeUrl}`);
  const leaseStart = Date.now();
  const leaseDeadline = start + DOCKER_READY_TIMEOUT_MS;
  let leaseSuccess = false;
  let lastLeaseError: string | undefined;
  let guardianAccessToken: string | undefined;

  while (Date.now() < leaseDeadline) {
    try {
      const tokenData = await leaseGuardianToken(
        runtimeUrl,
        instanceName,
        bootstrapSecret,
      );
      const leaseElapsed = ((Date.now() - leaseStart) / 1000).toFixed(1);
      log(
        `Guardian token lease: success after ${leaseElapsed}s (principalId=${tokenData.guardianPrincipalId}, expiresAt=${tokenData.accessTokenExpiresAt})`,
      );
      guardianAccessToken = tokenData.accessToken;
      leaseSuccess = true;
      break;
    } catch (err) {
      lastLeaseError =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
      // Log periodically so the user knows we're still trying
      const elapsed = ((Date.now() - leaseStart) / 1000).toFixed(0);
      log(
        `Guardian token lease: attempt failed after ${elapsed}s (${
          lastLeaseError.split("\n")[0]
        }), retrying...`,
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!leaseSuccess) {
    log(
      `\u26a0\ufe0f  Guardian token lease: FAILED after ${(
        (Date.now() - leaseStart) /
        1000
      ).toFixed(1)}s — ${lastLeaseError ?? "unknown error"}`,
    );
  }

  log("");
  log(`\u2705 Docker containers are up and running!`);
  log(`   Name: ${instanceName}`);
  log(`   Runtime: ${runtimeUrl}`);
  log("");
  return { ready: true, guardianAccessToken };
}
