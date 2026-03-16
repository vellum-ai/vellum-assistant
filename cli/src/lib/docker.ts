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

const DOCKERHUB_ORG = "vellumai";
const DOCKERHUB_IMAGES = {
  assistant: `${DOCKERHUB_ORG}/vellum-assistant`,
  credentialExecutor: `${DOCKERHUB_ORG}/vellum-credential-executor`,
  gateway: `${DOCKERHUB_ORG}/vellum-gateway`,
} as const;

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
function dockerResourceNames(instanceName: string) {
  return {
    assistantContainer: `${instanceName}-assistant`,
    cesContainer: `${instanceName}-credential-executor`,
    dataVolume: `vellum-data-${instanceName}`,
    gatewayContainer: `${instanceName}-gateway`,
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

  // Stop containers in reverse dependency order
  await removeContainer(res.cesContainer);
  await removeContainer(res.gatewayContainer);
  await removeContainer(res.assistantContainer);

  // Also clean up a legacy single-container instance if it exists
  await removeContainer(name);

  // Remove shared volumes
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
 * Locate the repository root by walking up from `cli/src/lib/` until we
 * find a directory containing the expected Dockerfiles.
 */
function findRepoRoot(): string {
  // cli/src/lib/ -> repo root
  const sourceTreeRoot = join(import.meta.dir, "..", "..", "..");
  if (existsSync(join(sourceTreeRoot, "assistant", "Dockerfile"))) {
    return sourceTreeRoot;
  }

  // Walk up from cwd as a fallback
  let dir = process.cwd();
  while (true) {
    if (existsSync(join(dir, "assistant", "Dockerfile"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
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
  imageTags: { assistant: string; credentialExecutor: string; gateway: string },
): Record<"assistant" | "credentialExecutor" | "gateway", ServiceImageConfig> {
  return {
    assistant: {
      context: repoRoot,
      dockerfile: "assistant/Dockerfile",
      tag: imageTags.assistant,
    },
    credentialExecutor: {
      context: repoRoot,
      dockerfile: "credential-executor/Dockerfile",
      tag: imageTags.credentialExecutor,
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
  imageTags: { assistant: string; credentialExecutor: string; gateway: string },
): Promise<void> {
  const configs = serviceImageConfigs(repoRoot, imageTags);
  for (const [name, config] of Object.entries(configs)) {
    console.log(`🔨 Building ${name}...`);
    await buildImage(config);
    console.log(`✅ ${name} built`);
  }
}

/** Start all three containers in dependency order. */
async function startContainers(opts: {
  assistantImage: string;
  cesImage: string;
  gatewayImage: string;
  gatewayPort: number;
  instanceName: string;
  res: ReturnType<typeof dockerResourceNames>;
}): Promise<void> {
  const { assistantImage, cesImage, gatewayImage, gatewayPort, instanceName, res } = opts;

  // ── Start assistant container ──
  // The assistant is the first container and owns the network namespace.
  // Gateway and CES join it via --network=container: so all three share
  // localhost. Port mappings must be declared here for all services.
  const assistantArgs: string[] = [
    "run",
    "--init",
    "-d",
    "--name",
    res.assistantContainer,
    "-p",
    `${gatewayPort}:${GATEWAY_INTERNAL_PORT}`,
    "-v",
    `${res.dataVolume}:/data`,
    "-v",
    `${res.socketVolume}:/run/ces-bootstrap`,
    "-e",
    `VELLUM_ASSISTANT_NAME=${instanceName}`,
  ];
  for (const envVar of ["ANTHROPIC_API_KEY", "VELLUM_PLATFORM_URL"]) {
    if (process.env[envVar]) {
      assistantArgs.push("-e", `${envVar}=${process.env[envVar]}`);
    }
  }
  console.log("🚀 Starting assistant container...");
  await exec("docker", [...assistantArgs, assistantImage]);

  // ── Start gateway container ──
  // Shares the assistant's network namespace so localhost:ASSISTANT_INTERNAL_PORT
  // reaches the assistant daemon.
  const gatewayArgs: string[] = [
    "run",
    "--init",
    "-d",
    "--name",
    res.gatewayContainer,
    `--network=container:${res.assistantContainer}`,
    "-v",
    `${res.dataVolume}:/data`,
    "-e",
    "BASE_DATA_DIR=/data",
    "-e",
    `GATEWAY_PORT=${GATEWAY_INTERNAL_PORT}`,
    "-e",
    `RUNTIME_HTTP_PORT=${ASSISTANT_INTERNAL_PORT}`,
  ];
  console.log("🚀 Starting gateway container...");
  await exec("docker", [...gatewayArgs, gatewayImage]);

  // ── Start credential-executor container ──
  // Shares the assistant's network namespace and communicates via a Unix
  // socket on the shared bootstrap volume.
  const cesArgs: string[] = [
    "run",
    "--init",
    "-d",
    "--name",
    res.cesContainer,
    `--network=container:${res.assistantContainer}`,
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
  ];
  console.log("🚀 Starting credential-executor container...");
  await exec("docker", [...cesArgs, cesImage]);
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
): Set<"assistant" | "credentialExecutor" | "gateway"> {
  const rel = filePath.startsWith(repoRoot)
    ? filePath.slice(repoRoot.length + 1)
    : filePath;

  const affected = new Set<"assistant" | "credentialExecutor" | "gateway">();

  if (rel.startsWith("assistant/")) {
    affected.add("assistant");
  }
  if (rel.startsWith("credential-executor/")) {
    affected.add("credentialExecutor");
  }
  if (rel.startsWith("gateway/")) {
    affected.add("gateway");
  }
  // Shared packages affect both assistant and credential-executor
  if (rel.startsWith("packages/")) {
    affected.add("assistant");
    affected.add("credentialExecutor");
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
  imageTags: { assistant: string; credentialExecutor: string; gateway: string };
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
  let pendingServices = new Set<"assistant" | "credentialExecutor" | "gateway">();
  let rebuilding = false;

  const configs = serviceImageConfigs(repoRoot, imageTags);

  async function rebuildAndRestart(): Promise<void> {
    if (rebuilding) return;
    rebuilding = true;

    const services = pendingServices;
    pendingServices = new Set();

    const serviceNames = [...services].join(", ");
    console.log(`\n🔄 Changes detected — rebuilding: ${serviceNames}`);

    try {
      // When assistant is rebuilt all containers must restart because
      // gateway and CES share the assistant's network namespace.
      const needsFullRestart = services.has("assistant");

      for (const service of services) {
        console.log(`🔨 Building ${service}...`);
        await buildImage(configs[service]);
        console.log(`✅ ${service} built`);
      }

      if (needsFullRestart) {
        console.log("🔄 Restarting all containers...");
        await stopContainers(res);
        await startContainers({
          assistantImage: imageTags.assistant,
          cesImage: imageTags.credentialExecutor,
          gatewayImage: imageTags.gateway,
          gatewayPort,
          instanceName,
          res,
        });
      } else {
        for (const service of services) {
          const container =
            service === "gateway" ? res.gatewayContainer : res.cesContainer;
          console.log(`🔄 Restarting ${container}...`);
          await removeContainer(container);

          if (service === "gateway") {
            await exec("docker", [
              "run", "--init", "-d",
              "--name", res.gatewayContainer,
              `--network=container:${res.assistantContainer}`,
              "-v", `${res.dataVolume}:/data`,
              "-e", "BASE_DATA_DIR=/data",
              "-e", `GATEWAY_PORT=${GATEWAY_INTERNAL_PORT}`,
              "-e", `RUNTIME_HTTP_PORT=${ASSISTANT_INTERNAL_PORT}`,
              imageTags.gateway,
            ]);
          } else {
            await exec("docker", [
              "run", "--init", "-d",
              "--name", res.cesContainer,
              `--network=container:${res.assistantContainer}`,
              "-v", `${res.socketVolume}:/run/ces-bootstrap`,
              "-v", `${res.dataVolume}:/data:ro`,
              "-e", "CES_MODE=managed",
              "-e", "CES_BOOTSTRAP_SOCKET_DIR=/run/ces-bootstrap",
              "-e", "CES_ASSISTANT_DATA_MOUNT=/data",
              imageTags.credentialExecutor,
            ]);
          }
        }
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

  let assistantImage: string;
  let gatewayImage: string;
  let cesImage: string;

  let repoRoot: string | undefined;

  if (watch) {
    repoRoot = findRepoRoot();
    const localTag = `local-${instanceName}`;
    assistantImage = `vellum-assistant:${localTag}`;
    gatewayImage = `vellum-gateway:${localTag}`;
    cesImage = `vellum-credential-executor:${localTag}`;

    console.log(`🥚 Hatching Docker assistant: ${instanceName}`);
    console.log(`   Species: ${species}`);
    console.log(`   Mode: development (watch)`);
    console.log(`   Repo: ${repoRoot}`);
    console.log(`   Images (local build):`);
    console.log(`     assistant:            ${assistantImage}`);
    console.log(`     gateway:              ${gatewayImage}`);
    console.log(`     credential-executor:  ${cesImage}`);
    console.log("");

    const logFd = openLogFile("hatch.log");
    console.log("🔨 Building Docker images from local source...");
    try {
      await buildAllImages(repoRoot, {
        assistant: assistantImage,
        credentialExecutor: cesImage,
        gateway: gatewayImage,
      });
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
    assistantImage = `${DOCKERHUB_IMAGES.assistant}:${versionTag}`;
    gatewayImage = `${DOCKERHUB_IMAGES.gateway}:${versionTag}`;
    cesImage = `${DOCKERHUB_IMAGES.credentialExecutor}:${versionTag}`;

    console.log(`🥚 Hatching Docker assistant: ${instanceName}`);
    console.log(`   Species: ${species}`);
    console.log(`   Images:`);
    console.log(`     assistant:            ${assistantImage}`);
    console.log(`     gateway:              ${gatewayImage}`);
    console.log(`     credential-executor:  ${cesImage}`);
    console.log("");

    const logFd = openLogFile("hatch.log");
    console.log("📦 Pulling Docker images...");
    try {
      await exec("docker", ["pull", assistantImage]);
      await exec("docker", ["pull", gatewayImage]);
      await exec("docker", ["pull", cesImage]);
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

  // Create shared volumes
  console.log("📁 Creating shared volumes...");
  await exec("docker", ["volume", "create", res.dataVolume]);
  await exec("docker", ["volume", "create", res.socketVolume]);

  await startContainers({
    assistantImage,
    cesImage,
    gatewayImage,
    gatewayPort,
    instanceName,
    res,
  });

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
    const imageTags = {
      assistant: assistantImage,
      credentialExecutor: cesImage,
      gateway: gatewayImage,
    };

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
