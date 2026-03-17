import { spawn as nodeSpawn } from "child_process";
import { existsSync, watch as fsWatch } from "fs";
import { dirname, join } from "path";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../package.json";

import { saveAssistantEntry, setActiveAssistant } from "./assistant-config";
import type { AssistantEntry } from "./assistant-config";
import { DEFAULT_GATEWAY_PORT } from "./constants";
import type { Species } from "./constants";
import { leaseGuardianToken } from "./guardian-token";
import { generateInstanceName } from "./random-name";
import { exec, execOutput } from "./step-runner";
import {
  closeLogFile,
  openLogFile,
  resetLogFile,
  writeToLogFile,
} from "./xdg-log";

type ServiceName = "assistant" | "credential-executor" | "gateway";

const DOCKERHUB_ORG = "vellumai";
const DOCKERHUB_IMAGES: Record<ServiceName, string> = {
  assistant: `${DOCKERHUB_ORG}/vellum-assistant`,
  "credential-executor": `${DOCKERHUB_ORG}/vellum-credential-executor`,
  gateway: `${DOCKERHUB_ORG}/vellum-gateway`,
};

/** Internal ports exposed by each service's Dockerfile. */
const ASSISTANT_INTERNAL_PORT = 3001;
const GATEWAY_INTERNAL_PORT = 7830;

/**
 * Checks whether the `docker` CLI and daemon are available on the system.
 * Installs Colima and Docker via Homebrew if the CLI is missing, and starts
 * Colima if the Docker daemon is not reachable.
 */
async function ensureDockerInstalled(): Promise<void> {
  let installed = false;
  try {
    await execOutput("docker", ["--version"]);
    installed = true;
  } catch {
    // docker CLI not found — install it
  }

  if (!installed) {
    // Check whether Homebrew is available before attempting to use it.
    let hasBrew = false;
    try {
      await execOutput("brew", ["--version"]);
      hasBrew = true;
    } catch {
      // brew not found
    }

    if (!hasBrew) {
      console.log("🍺 Homebrew not found. Installing Homebrew...");
      try {
        await exec("bash", [
          "-c",
          'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to install Homebrew. Please install Docker manually from https://www.docker.com/products/docker-desktop/\n${message}`,
        );
      }

      // Homebrew on Apple Silicon installs to /opt/homebrew; add it to PATH
      // so subsequent brew/colima/docker invocations work in this session.
      if (!process.env.PATH?.includes("/opt/homebrew")) {
        process.env.PATH = `/opt/homebrew/bin:/opt/homebrew/sbin:${process.env.PATH}`;
      }
    }

    console.log("🐳 Docker not found. Installing via Homebrew...");
    try {
      await exec("brew", ["install", "colima", "docker"]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to install Docker via Homebrew. Please install Docker manually.\n${message}`,
      );
    }

    try {
      await execOutput("docker", ["--version"]);
    } catch {
      throw new Error(
        "Docker was installed but is still not available on PATH. " +
          "You may need to restart your terminal.",
      );
    }
  }

  // Verify the Docker daemon is reachable; start Colima if it isn't
  try {
    await exec("docker", ["info"]);
  } catch {
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
      await exec("colima", ["start"]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to start Colima. Please run 'colima start' manually.\n${message}`,
      );
    }
  }
}

/**
 * Creates a line-buffered output prefixer that prepends a tag to each
 * line from a container's stdout/stderr. Calls `onLine` for each complete
 * line so the caller can detect sentinel output (e.g. hatch completion).
 */
function createLinePrefixer(
  stream: NodeJS.WritableStream,
  prefix: string,
  onLine?: (line: string) => void,
): { write(data: Buffer): void; flush(): void } {
  let remainder = "";
  return {
    write(data: Buffer) {
      const text = remainder + data.toString();
      const lines = text.split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        stream.write(`   [${prefix}] ${line}\n`);
        onLine?.(line);
      }
    },
    flush() {
      if (remainder) {
        stream.write(`   [${prefix}] ${remainder}\n`);
        onLine?.(remainder);
        remainder = "";
      }
    },
  };
}

/** Derive the Docker resource names from the instance name. */
export function dockerResourceNames(instanceName: string) {
  return {
    assistantContainer: `${instanceName}-assistant`,
    cesContainer: `${instanceName}-credential-executor`,
    dataVolume: `vellum-data-${instanceName}`,
    gatewayContainer: `${instanceName}-gateway`,
    network: `vellum-net-${instanceName}`,
    socketVolume: `vellum-ces-bootstrap-${instanceName}`,
  };
}

/** Silently attempt to stop and remove a Docker container. */
async function removeContainer(containerName: string): Promise<void> {
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

  const res = dockerResourceNames(name);

  await removeContainer(res.cesContainer);
  await removeContainer(res.gatewayContainer);
  await removeContainer(res.assistantContainer);

  // Also clean up a legacy single-container instance if it exists
  await removeContainer(name);

  // Remove shared network and volumes
  try {
    await exec("docker", ["network", "rm", res.network]);
  } catch {
    // network may not exist
  }
  for (const vol of [res.dataVolume, res.socketVolume]) {
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
): Promise<void> {
  const configs = serviceImageConfigs(repoRoot, imageTags);
  console.log("🔨 Building all images in parallel...");
  await Promise.all(
    Object.entries(configs).map(async ([name, config]) => {
      await buildImage(config);
      console.log(`✅ ${name} built`);
    }),
  );
}

/**
 * Returns a function that builds the `docker run` arguments for a given
 * service. Each container joins a shared Docker bridge network so they
 * can be restarted independently.
 */
function serviceDockerRunArgs(opts: {
  gatewayPort: number;
  imageTags: Record<ServiceName, string>;
  instanceName: string;
  res: ReturnType<typeof dockerResourceNames>;
}): Record<ServiceName, () => string[]> {
  const { gatewayPort, imageTags, instanceName, res } = opts;
  return {
    assistant: () => {
      const args: string[] = [
        "run",
        "--init",
        "-d",
        "--name",
        res.assistantContainer,
        `--network=${res.network}`,
        "-v",
        `${res.dataVolume}:/data`,
        "-v",
        `${res.socketVolume}:/run/ces-bootstrap`,
        "-e",
        `VELLUM_ASSISTANT_NAME=${instanceName}`,
        "-e",
        "RUNTIME_HTTP_HOST=0.0.0.0",
      ];
      for (const envVar of ["ANTHROPIC_API_KEY", "VELLUM_PLATFORM_URL"]) {
        if (process.env[envVar]) {
          args.push("-e", `${envVar}=${process.env[envVar]}`);
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
      `--network=${res.network}`,
      "-p",
      `${gatewayPort}:${GATEWAY_INTERNAL_PORT}`,
      "-v",
      `${res.dataVolume}:/data`,
      "-e",
      "BASE_DATA_DIR=/data",
      "-e",
      `GATEWAY_PORT=${GATEWAY_INTERNAL_PORT}`,
      "-e",
      `ASSISTANT_HOST=${res.assistantContainer}`,
      "-e",
      `RUNTIME_HTTP_PORT=${ASSISTANT_INTERNAL_PORT}`,
      imageTags.gateway,
    ],
    "credential-executor": () => [
      "run",
      "--init",
      "-d",
      "--name",
      res.cesContainer,
      `--network=${res.network}`,
      "-v",
      `${res.socketVolume}:/run/ces-bootstrap`,
      "-v",
      `${res.dataVolume}:/data:ro`,
      "-e",
      "CES_MODE=managed",
      "-e",
      "CES_BOOTSTRAP_SOCKET_DIR=/run/ces-bootstrap",
      "-e",
      "CES_ASSISTANT_DATA_MOUNT=/data",
      imageTags["credential-executor"],
    ],
  };
}

/** The order in which services must be started. */
const SERVICE_START_ORDER: ServiceName[] = [
  "assistant",
  "gateway",
  "credential-executor",
];

/** Start all three containers in dependency order. */
async function startContainers(opts: {
  gatewayPort: number;
  imageTags: Record<ServiceName, string>;
  instanceName: string;
  res: ReturnType<typeof dockerResourceNames>;
}): Promise<void> {
  const runArgs = serviceDockerRunArgs(opts);
  for (const service of SERVICE_START_ORDER) {
    console.log(`🚀 Starting ${service} container...`);
    await exec("docker", runArgs[service]());
  }
}

/** Stop and remove all three containers (ignoring errors). */
async function stopContainers(
  res: ReturnType<typeof dockerResourceNames>,
): Promise<void> {
  await removeContainer(res.cesContainer);
  await removeContainer(res.gatewayContainer);
  await removeContainer(res.assistantContainer);
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

      for (const service of services) {
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
): Promise<void> {
  resetLogFile("hatch.log");

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
    const localTag = `local-${instanceName}`;
    imageTags.assistant = `vellum-assistant:${localTag}`;
    imageTags.gateway = `vellum-gateway:${localTag}`;
    imageTags["credential-executor"] = `vellum-credential-executor:${localTag}`;

    console.log(`🥚 Hatching Docker assistant: ${instanceName}`);
    console.log(`   Species: ${species}`);
    console.log(`   Mode: development (watch)`);
    console.log(`   Repo: ${repoRoot}`);
    console.log(`   Images (local build):`);
    console.log(`     assistant:            ${imageTags.assistant}`);
    console.log(`     gateway:              ${imageTags.gateway}`);
    console.log(
      `     credential-executor:  ${imageTags["credential-executor"]}`,
    );
    console.log("");

    const logFd = openLogFile("hatch.log");
    try {
      await buildAllImages(repoRoot, imageTags);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeToLogFile(
        logFd,
        `[docker-build] ${new Date().toISOString()} ERROR\n${message}\n`,
      );
      closeLogFile(logFd);
      throw err;
    }
    closeLogFile(logFd);
    console.log("✅ Docker images built\n");
  } else {
    const version = cliPkg.version;
    const versionTag = version ? `v${version}` : "latest";
    imageTags.assistant = `${DOCKERHUB_IMAGES.assistant}:${versionTag}`;
    imageTags.gateway = `${DOCKERHUB_IMAGES.gateway}:${versionTag}`;
    imageTags["credential-executor"] =
      `${DOCKERHUB_IMAGES["credential-executor"]}:${versionTag}`;

    console.log(`🥚 Hatching Docker assistant: ${instanceName}`);
    console.log(`   Species: ${species}`);
    console.log(`   Images:`);
    console.log(`     assistant:            ${imageTags.assistant}`);
    console.log(`     gateway:              ${imageTags.gateway}`);
    console.log(
      `     credential-executor:  ${imageTags["credential-executor"]}`,
    );
    console.log("");

    const logFd = openLogFile("hatch.log");
    console.log("📦 Pulling Docker images...");
    try {
      await exec("docker", ["pull", imageTags.assistant]);
      await exec("docker", ["pull", imageTags.gateway]);
      await exec("docker", ["pull", imageTags["credential-executor"]]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeToLogFile(
        logFd,
        `[docker-pull] ${new Date().toISOString()} ERROR\n${message}\n`,
      );
      closeLogFile(logFd);
      throw err;
    }
    closeLogFile(logFd);
    console.log("✅ Docker images pulled\n");
  }

  const res = dockerResourceNames(instanceName);

  // Create shared network and volumes
  console.log("📁 Creating shared network and volumes...");
  await exec("docker", ["network", "create", res.network]);
  await exec("docker", ["volume", "create", res.dataVolume]);
  await exec("docker", ["volume", "create", res.socketVolume]);

  await startContainers({ gatewayPort, imageTags, instanceName, res });

  const runtimeUrl = `http://localhost:${gatewayPort}`;
  const dockerEntry: AssistantEntry = {
    assistantId: instanceName,
    runtimeUrl,
    cloud: "docker",
    species,
    hatchedAt: new Date().toISOString(),
    volume: res.dataVolume,
  };
  saveAssistantEntry(dockerEntry);
  setActiveAssistant(instanceName);

  // The assistant image runs the daemon directly (not via the CLI hatch
  // command), so we watch for the DaemonServer readiness message instead
  // of the CLI's "Local assistant hatched!" sentinel.
  await tailContainerUntilReady({
    containerName: res.assistantContainer,
    detached: watch ? false : detached,
    dockerEntry,
    instanceName,
    runtimeUrl,
    sentinel: "DaemonServer started",
  });

  if (watch && repoRoot) {
    const stopWatcher = startFileWatcher({
      gatewayPort,
      imageTags,
      instanceName,
      repoRoot,
      res,
    });

    await new Promise<void>((resolve) => {
      const cleanup = async () => {
        console.log("\n🛑 Shutting down...");
        stopWatcher();
        await stopContainers(res);
        console.log("✅ Docker instance stopped.");
        resolve();
      };

      process.on("SIGINT", () => void cleanup());
      process.on("SIGTERM", () => void cleanup());
    });
  }
}

/**
 * In detached mode, print instance details and return immediately.
 * Otherwise, tail the given container's logs until the sentinel string
 * appears, then attempt to lease a guardian token and report readiness.
 */
async function tailContainerUntilReady(opts: {
  containerName: string;
  detached: boolean;
  dockerEntry: AssistantEntry;
  instanceName: string;
  runtimeUrl: string;
  sentinel: string;
}): Promise<void> {
  const {
    containerName,
    detached,
    dockerEntry,
    instanceName,
    runtimeUrl,
    sentinel,
  } = opts;

  if (detached) {
    console.log("\n✅ Docker assistant hatched!\n");
    console.log("Instance details:");
    console.log(`  Name: ${instanceName}`);
    console.log(`  Runtime: ${runtimeUrl}`);
    console.log(`  Container: ${containerName}`);
    console.log("");
    console.log(`Stop with: vellum retire ${instanceName}`);
    return;
  }

  console.log(`  Container: ${containerName}`);
  console.log(`  Runtime: ${runtimeUrl}`);
  console.log("");

  await new Promise<void>((resolve, reject) => {
    const child = nodeSpawn("docker", ["logs", "-f", containerName], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handleLine = (line: string): void => {
      if (line.includes(sentinel)) {
        process.nextTick(async () => {
          try {
            const tokenData = await leaseGuardianToken(
              runtimeUrl,
              instanceName,
            );
            dockerEntry.bearerToken = tokenData.accessToken;
            saveAssistantEntry(dockerEntry);
          } catch (err) {
            console.warn(
              `\u26a0\ufe0f  Could not lease guardian token: ${err instanceof Error ? err.message : err}`,
            );
          }

          console.log("");
          console.log(`\u2705 Docker containers are up and running!`);
          console.log(`   Name: ${instanceName}`);
          console.log(`   Runtime: ${runtimeUrl}`);
          console.log("");
          child.kill();
          resolve();
        });
      }
    };

    const stdoutPrefixer = createLinePrefixer(
      process.stdout,
      "docker",
      handleLine,
    );
    const stderrPrefixer = createLinePrefixer(
      process.stderr,
      "docker",
      handleLine,
    );

    child.stdout?.on("data", (data: Buffer) => stdoutPrefixer.write(data));
    child.stderr?.on("data", (data: Buffer) => stderrPrefixer.write(data));
    child.stdout?.on("end", () => stdoutPrefixer.flush());
    child.stderr?.on("end", () => stderrPrefixer.flush());

    child.on("close", (code) => {
      if (
        code === 0 ||
        code === null ||
        code === 130 ||
        code === 137 ||
        code === 143
      ) {
        resolve();
      } else {
        reject(new Error(`Docker container exited with code ${code}`));
      }
    });
    child.on("error", reject);

    process.on("SIGINT", () => {
      child.kill();
      resolve();
    });
  });
}
