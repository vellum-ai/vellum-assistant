import { randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, watch as fsWatch } from "fs";
import { arch, platform } from "os";
import { dirname, join } from "path";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../package.json";

import {
  findAssistantByName,
  saveAssistantEntry,
  setActiveAssistant,
} from "./assistant-config";
import type { AssistantEntry } from "./assistant-config";
import { writeInitialConfig } from "./config-utils";
import { DEFAULT_GATEWAY_PORT } from "./constants";
import { PROVIDER_ENV_VAR_NAMES } from "../shared/provider-env-vars.js";
import type { Species } from "./constants";
import { leaseGuardianToken } from "./guardian-token";
import { isVellumProcess, stopProcess } from "./process";
import { generateInstanceName } from "./random-name";
import { resolveImageRefs } from "./platform-releases.js";
import { exec, execOutput } from "./step-runner";
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

/** Internal ports exposed by each service's Dockerfile. */
export const ASSISTANT_INTERNAL_PORT = 3001;
export const GATEWAY_INTERNAL_PORT = 7830;

/** Max time to wait for the assistant container to emit the readiness sentinel. */
export const DOCKER_READY_TIMEOUT_MS = 3 * 60 * 1000;

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
    cesContainer: `${instanceName}-credential-executor`,
    cesSecurityVolume: `${instanceName}-ces-sec`,
    gatewayContainer: `${instanceName}-gateway`,
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
      context: join(repoRoot, "gateway"),
      dockerfile: "Dockerfile",
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

/**
 * Returns a function that builds the `docker run` arguments for a given
 * service. All three containers share a network namespace via
 * `--network=container:` so inter-service traffic is over localhost,
 * matching the platform's Kubernetes pod topology.
 */
export function serviceDockerRunArgs(opts: {
  signingKey?: string;
  bootstrapSecret?: string;
  cesServiceToken?: string;
  extraAssistantEnv?: Record<string, string>;
  gatewayPort: number;
  imageTags: Record<ServiceName, string>;
  defaultWorkspaceConfigPath?: string;
  instanceName: string;
  res: ReturnType<typeof dockerResourceNames>;
}): Record<ServiceName, () => string[]> {
  const {
    cesServiceToken,
    defaultWorkspaceConfigPath,
    extraAssistantEnv,
    gatewayPort,
    imageTags,
    instanceName,
    res,
  } = opts;
  return {
    assistant: () => {
      const args: string[] = [
        "run",
        "--init",
        "-d",
        "--name",
        res.assistantContainer,
        `--network=${res.network}`,
        "-p",
        `${gatewayPort}:${GATEWAY_INTERNAL_PORT}`,
        "-v",
        `${res.workspaceVolume}:/workspace`,
        "-v",
        `${res.socketVolume}:/run/ces-bootstrap`,
        "-e",
        "IS_CONTAINERIZED=true",
        "-e",
        `VELLUM_ASSISTANT_NAME=${instanceName}`,
        "-e",
        "VELLUM_CLOUD=docker",
        "-e",
        "RUNTIME_HTTP_HOST=0.0.0.0",
        "-e",
        "VELLUM_WORKSPACE_DIR=/workspace",
        "-e",
        "VELLUM_BACKUP_DIR=/workspace/.backups",
        "-e",
        "VELLUM_BACKUP_KEY_PATH=/workspace/.backup.key",
        "-e",
        "CES_CREDENTIAL_URL=http://localhost:8090",
        "-e",
        `GATEWAY_INTERNAL_URL=http://localhost:${GATEWAY_INTERNAL_PORT}`,
      ];
      if (defaultWorkspaceConfigPath) {
        const containerPath = `/tmp/vellum-default-workspace-config-${Date.now()}.json`;
        args.push(
          "-v",
          `${defaultWorkspaceConfigPath}:${containerPath}:ro`,
          "-e",
          `VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH=${containerPath}`,
        );
      }
      if (cesServiceToken) {
        args.push("-e", `CES_SERVICE_TOKEN=${cesServiceToken}`);
      }
      if (opts.signingKey) {
        args.push("-e", `ACTOR_TOKEN_SIGNING_KEY=${opts.signingKey}`);
      }
      for (const envVar of [
        ...Object.values(PROVIDER_ENV_VAR_NAMES),
        "VELLUM_PLATFORM_URL",
      ]) {
        if (process.env[envVar]) {
          args.push("-e", `${envVar}=${process.env[envVar]}`);
        }
      }
      if (extraAssistantEnv) {
        for (const [key, value] of Object.entries(extraAssistantEnv)) {
          args.push("-e", `${key}=${value}`);
        }
      }
      args.push(imageTags.assistant);
      return args;
    },
    gateway: () => [
      "run",
      "--init",
      "-d",
      "--name",
      res.gatewayContainer,
      `--network=container:${res.assistantContainer}`,
      "-v",
      `${res.workspaceVolume}:/workspace`,
      "-v",
      `${res.gatewaySecurityVolume}:/gateway-security`,
      "-e",
      "VELLUM_WORKSPACE_DIR=/workspace",
      "-e",
      "GATEWAY_SECURITY_DIR=/gateway-security",
      "-e",
      `GATEWAY_PORT=${GATEWAY_INTERNAL_PORT}`,
      "-e",
      "ASSISTANT_HOST=localhost",
      "-e",
      `RUNTIME_HTTP_PORT=${ASSISTANT_INTERNAL_PORT}`,
      "-e",
      "RUNTIME_PROXY_ENABLED=true",
      "-e",
      "CES_CREDENTIAL_URL=http://localhost:8090",
      ...(cesServiceToken
        ? ["-e", `CES_SERVICE_TOKEN=${cesServiceToken}`]
        : []),
      ...(opts.signingKey
        ? ["-e", `ACTOR_TOKEN_SIGNING_KEY=${opts.signingKey}`]
        : []),
      ...(opts.bootstrapSecret
        ? ["-e", `GUARDIAN_BOOTSTRAP_SECRET=${opts.bootstrapSecret}`]
        : []),
      ...(process.env.VELLUM_PLATFORM_URL
        ? ["-e", `VELLUM_PLATFORM_URL=${process.env.VELLUM_PLATFORM_URL}`]
        : []),
      imageTags.gateway,
    ],
    "credential-executor": () => [
      "run",
      "--init",
      "-d",
      "--name",
      res.cesContainer,
      `--network=container:${res.assistantContainer}`,
      "-v",
      `${res.socketVolume}:/run/ces-bootstrap`,
      "-v",
      `${res.workspaceVolume}:/workspace:ro`,
      "-v",
      `${res.cesSecurityVolume}:/ces-security`,
      "-e",
      "CES_MODE=managed",
      "-e",
      "VELLUM_WORKSPACE_DIR=/workspace",
      "-e",
      "CES_BOOTSTRAP_SOCKET_DIR=/run/ces-bootstrap",
      "-e",
      "CREDENTIAL_SECURITY_DIR=/ces-security",
      ...(cesServiceToken
        ? ["-e", `CES_SERVICE_TOKEN=${cesServiceToken}`]
        : []),
      imageTags["credential-executor"],
    ],
  };
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
    gatewayPort: number;
    imageTags: Record<ServiceName, string>;
    defaultWorkspaceConfigPath?: string;
    instanceName: string;
    res: ReturnType<typeof dockerResourceNames>;
  },
  log: (msg: string) => void,
): Promise<void> {
  const runArgs = serviceDockerRunArgs(opts);
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
    await exec("colima", [
      "start",
      "--memory",
      String(COLIMA_DEFAULT_MEMORY_GIB),
    ]);
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
 * Watch for file changes in the assistant, gateway, credential-executor,
 * and packages directories. When changes are detected, rebuild the affected
 * images and restart their containers.
 */
function startFileWatcher(opts: {
  signingKey?: string;
  bootstrapSecret?: string;
  cesServiceToken?: string;
  gatewayPort: number;
  imageTags: Record<ServiceName, string>;
  instanceName: string;
  repoRoot: string;
  res: ReturnType<typeof dockerResourceNames>;
}): () => void {
  const { gatewayPort, imageTags, instanceName, repoRoot, res } = opts;

  const watchDirs = [
    join(repoRoot, "assistant"),
    join(repoRoot, "credential-executor"),
    join(repoRoot, "gateway"),
    join(repoRoot, "packages"),
  ];

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingServices = new Set<ServiceName>();
  let rebuilding = false;

  const configs = serviceImageConfigs(repoRoot, imageTags);
  const runArgs = serviceDockerRunArgs({
    signingKey: opts.signingKey,
    bootstrapSecret: opts.bootstrapSecret,
    cesServiceToken: opts.cesServiceToken,
    gatewayPort,
    imageTags,
    instanceName,
    res,
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

  for (const dir of watchDirs) {
    if (!existsSync(dir)) continue;
    const watcher = fsWatch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (
        filename.includes("node_modules") ||
        filename.includes(".env") ||
        filename.startsWith(".")
      ) {
        return;
      }

      const fullPath = join(dir, filename);
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
    });
    watchers.push(watcher);
  }

  console.log("👀 Watching for file changes in:");
  console.log("   assistant/, gateway/, credential-executor/, packages/");
  console.log("");

  return () => {
    for (const watcher of watchers) {
      watcher.close();
    }
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}

export async function hatchDocker(
  species: Species,
  detached: boolean,
  name: string | null,
  watch: boolean = false,
  configValues: Record<string, string> = {},
): Promise<void> {
  resetLogFile("hatch.log");

  let logFd = openLogFile("hatch.log");
  const log = (msg: string): void => {
    console.log(msg);
    writeToLogFile(logFd, `${new Date().toISOString()} ${msg}\n`);
  };

  try {
    emitProgress(1, 6, "Checking Docker...");
    await ensureDockerInstalled();

    const instanceName = generateInstanceName(species, name);
    const gatewayPort = DEFAULT_GATEWAY_PORT;

    const imageTags: Record<ServiceName, string> = {
      assistant: "",
      "credential-executor": "",
      gateway: "",
    };

    let repoRoot: string | undefined;

    if (watch) {
      repoRoot = findRepoRoot();

      // When running from a packaged .app bundle, the Dockerfiles are
      // present (so findRepoRoot succeeds) but the full source tree is
      // not — we can't build images locally. Fall back to pulling
      // pre-built images instead.
      if (!hasFullSourceTree(repoRoot)) {
        log(
          "⚠️  Dockerfiles found but no source tree — falling back to image pull",
        );
        watch = false;
        repoRoot = undefined;
      }
    }

    if (watch && repoRoot) {
      emitProgress(2, 6, "Building images...");
      const localTag = `local-${instanceName}`;
      imageTags.assistant = `vellum-assistant:${localTag}`;
      imageTags.gateway = `vellum-gateway:${localTag}`;
      imageTags["credential-executor"] =
        `vellum-credential-executor:${localTag}`;

      log(`🥚 Hatching Docker assistant: ${instanceName}`);
      log(`   Species: ${species}`);
      log(`   Mode: development (watch)`);
      log(`   Repo: ${repoRoot}`);
      log(`   Images (local build):`);
      log(`     assistant:            ${imageTags.assistant}`);
      log(`     gateway:              ${imageTags.gateway}`);
      log(`     credential-executor:  ${imageTags["credential-executor"]}`);
      log("");

      await buildAllImages(repoRoot, imageTags, log);
      log("✅ Docker images built");
    }

    if (!watch || !repoRoot) {
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
        const version = cliPkg.version;
        const versionTag = version ? `v${version}` : "latest";
        log("🔍 Resolving image references...");
        const resolved = await resolveImageRefs(versionTag, log);
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

      log("📦 Pulling Docker images...");
      await exec("docker", ["pull", imageTags.assistant]);
      await exec("docker", ["pull", imageTags.gateway]);
      await exec("docker", ["pull", imageTags["credential-executor"]]);
      log("✅ Docker images pulled");
    }

    const res = dockerResourceNames(instanceName);

    emitProgress(3, 6, "Creating volumes...");
    log("📁 Creating network and volumes...");
    await exec("docker", ["network", "create", res.network]);
    await exec("docker", ["volume", "create", res.socketVolume]);
    await exec("docker", ["volume", "create", res.workspaceVolume]);
    await exec("docker", ["volume", "create", res.cesSecurityVolume]);
    await exec("docker", ["volume", "create", res.gatewaySecurityVolume]);

    // Set workspace volume ownership so non-root containers (UID 1001) can write.
    await exec("docker", [
      "run",
      "--rm",
      "-v",
      `${res.workspaceVolume}:/workspace`,
      "busybox",
      "chown",
      "1001:1001",
      "/workspace",
    ]);

    // Write --config key=value pairs to a temp file that gets bind-mounted
    // into the assistant container and read via VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH.
    const defaultWorkspaceConfigPath = writeInitialConfig(configValues);

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
    await startContainers(
      {
        signingKey,
        bootstrapSecret,
        cesServiceToken,
        gatewayPort,
        imageTags,
        defaultWorkspaceConfigPath,
        instanceName,
        res,
      },
      log,
    );

    const imageDigests = await captureImageRefs(res);

    const runtimeUrl = `http://localhost:${gatewayPort}`;
    const dockerEntry: AssistantEntry = {
      assistantId: instanceName,
      runtimeUrl,
      cloud: "docker",
      species,
      hatchedAt: new Date().toISOString(),
      containerInfo: {
        assistantImage: imageTags.assistant,
        gatewayImage: imageTags.gateway,
        cesImage: imageTags["credential-executor"],
        assistantDigest: imageDigests?.assistant,
        gatewayDigest: imageDigests?.gateway,
        cesDigest: imageDigests?.["credential-executor"],
        networkName: res.network,
      },
    };
    emitProgress(5, 6, "Saving configuration...");
    saveAssistantEntry(dockerEntry);
    setActiveAssistant(instanceName);

    emitProgress(6, 6, "Waiting for services...");
    const { ready } = await waitForGatewayAndLease({
      bootstrapSecret: ownSecret,
      containerName: res.assistantContainer,
      detached: watch ? false : detached,
      instanceName,
      logFd,
      runtimeUrl,
    });

    if (!ready && !(watch && repoRoot)) {
      throw new Error("Timed out waiting for assistant to become ready");
    }

    if (watch && repoRoot) {
      saveAssistantEntry({ ...dockerEntry, watcherPid: process.pid });

      const stopWatcher = startFileWatcher({
        signingKey,
        bootstrapSecret,
        cesServiceToken,
        gatewayPort,
        imageTags,
        instanceName,
        repoRoot,
        res,
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
}): Promise<{ ready: boolean }> {
  const {
    bootstrapSecret,
    containerName,
    detached,
    instanceName,
    logFd,
    runtimeUrl,
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
    return { ready: true };
  }

  log(`  Container: ${containerName}`);
  log(`  Runtime: ${runtimeUrl}`);
  log("");
  log("Waiting for assistant to become ready...");

  const readyUrl = `${runtimeUrl}/readyz`;
  const start = Date.now();
  let ready = false;

  while (Date.now() - start < DOCKER_READY_TIMEOUT_MS) {
    try {
      const resp = await fetch(readyUrl, {
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

  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
  log(`Assistant ready after ${elapsedSec}s`);

  // Lease guardian token. The /readyz check confirms both gateway and
  // assistant are reachable. Retry with backoff in case there is a brief
  // window where readiness passes but the guardian endpoint is not yet ready.
  log(`Guardian token lease: starting for ${instanceName} at ${runtimeUrl}`);
  const leaseStart = Date.now();
  const leaseDeadline = start + DOCKER_READY_TIMEOUT_MS;
  let leaseSuccess = false;
  let lastLeaseError: string | undefined;

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
  return { ready: true };
}
