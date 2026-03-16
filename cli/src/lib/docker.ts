import { spawn as nodeSpawn } from "child_process";

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

export async function hatchDocker(
  species: Species,
  detached: boolean,
  name: string | null,
): Promise<void> {
  resetLogFile("hatch.log");

  await ensureDockerInstalled();

  const instanceName = generateInstanceName(species, name);
  const gatewayPort = DEFAULT_GATEWAY_PORT;

  const version = cliPkg.version;
  const versionTag = version ? `v${version}` : "latest";
  const assistantImage = `${DOCKERHUB_IMAGES.assistant}:${versionTag}`;
  const gatewayImage = `${DOCKERHUB_IMAGES.gateway}:${versionTag}`;
  const cesImage = `${DOCKERHUB_IMAGES.credentialExecutor}:${versionTag}`;

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

  const res = dockerResourceNames(instanceName);

  // Create shared volumes
  console.log("📁 Creating shared volumes...");
  await exec("docker", ["volume", "create", res.dataVolume]);
  await exec("docker", ["volume", "create", res.socketVolume]);

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
    detached,
    dockerEntry,
    instanceName,
    runtimeUrl,
    sentinel: "DaemonServer started",
  });
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
