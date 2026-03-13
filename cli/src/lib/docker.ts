import { spawn as nodeSpawn } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";

import { saveAssistantEntry, setActiveAssistant } from "./assistant-config";
import type { AssistantEntry } from "./assistant-config";
import { DEFAULT_GATEWAY_PORT } from "./constants";
import type { Species } from "./constants";
import { generateRandomSuffix } from "./random-name";
import { exec, execOutput } from "./step-runner";
import {
  closeLogFile,
  openLogFile,
  resetLogFile,
  writeToLogFile,
} from "./xdg-log";

const _require = createRequire(import.meta.url);

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

interface DockerRoot {
  /** Directory to use as the Docker build context */
  root: string;
  /** Relative path from root to the directory containing the Dockerfiles */
  dockerfileDir: string;
}

/**
 * Locate the directory containing the Dockerfile. In the source tree the
 * Dockerfiles live under `meta/`, but when installed as an npm package they
 * are at the package root.
 */
function findDockerRoot(developmentMode: boolean = false): DockerRoot {
  // Source tree: cli/src/lib/ -> repo root (Dockerfiles in meta/)
  const sourceTreeRoot = join(import.meta.dir, "..", "..", "..");
  if (existsSync(join(sourceTreeRoot, "meta", "Dockerfile"))) {
    return { root: sourceTreeRoot, dockerfileDir: "meta" };
  }

  // bunx layout: @vellumai/cli/src/lib/ -> ../../../.. -> node_modules -> vellum/
  const bunxRoot = join(import.meta.dir, "..", "..", "..", "..", "vellum");
  if (existsSync(join(bunxRoot, "Dockerfile"))) {
    return { root: bunxRoot, dockerfileDir: "." };
  }

  // Walk up from cwd looking for meta/Dockerfile (source checkout)
  let dir = process.cwd();
  while (true) {
    if (existsSync(join(dir, "meta", "Dockerfile"))) {
      return { root: dir, dockerfileDir: "meta" };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // In development mode, walk up from the executable path to find the repo
  // root. This handles the macOS app bundle case where the binary lives inside
  // the repo at e.g. clients/macos/dist/Vellum.app/Contents/MacOS/.
  if (developmentMode) {
    let execDir = dirname(process.execPath);
    while (true) {
      if (existsSync(join(execDir, "meta", "Dockerfile.development"))) {
        return { root: execDir, dockerfileDir: "meta" };
      }
      const parent = dirname(execDir);
      if (parent === execDir) break;
      execDir = parent;
    }
  }

  // macOS app bundle: Contents/MacOS/vellum-cli -> Contents/Resources/Dockerfile
  const appResourcesDir = join(dirname(process.execPath), "..", "Resources");
  if (existsSync(join(appResourcesDir, "Dockerfile"))) {
    return { root: appResourcesDir, dockerfileDir: "." };
  }

  // Fall back to Node module resolution for the `vellum` package
  try {
    const vellumPkgPath = _require.resolve("vellum/package.json");
    const vellumDir = dirname(vellumPkgPath);
    if (existsSync(join(vellumDir, "Dockerfile"))) {
      return { root: vellumDir, dockerfileDir: "." };
    }
  } catch {
    // resolution failed
  }

  throw new Error(
    "Could not find Dockerfile. Run this command from within the " +
      "vellum-assistant repository, or ensure the vellum package is installed.",
  );
}

/**
 * Creates a line-buffered output prefixer that prepends `[docker]` to each
 * line from the container's stdout/stderr. Calls `onLine` for each complete
 * line so the caller can detect sentinel output (e.g. hatch completion).
 */
function createLinePrefixer(
  stream: NodeJS.WritableStream,
  onLine?: (line: string) => void,
): { write(data: Buffer): void; flush(): void } {
  let remainder = "";
  return {
    write(data: Buffer) {
      const text = remainder + data.toString();
      const lines = text.split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        stream.write(`   [docker] ${line}\n`);
        onLine?.(line);
      }
    },
    flush() {
      if (remainder) {
        stream.write(`   [docker] ${remainder}\n`);
        onLine?.(remainder);
        remainder = "";
      }
    },
  };
}

async function fetchRemoteBearerToken(
  containerName: string,
): Promise<string | null> {
  try {
    const remoteCmd =
      'cat ~/.vellum.lock.json 2>/dev/null || cat ~/.vellum.lockfile.json 2>/dev/null || echo "{}"';
    const output = await execOutput("docker", [
      "exec",
      containerName,
      "sh",
      "-c",
      remoteCmd,
    ]);
    const data = JSON.parse(output.trim());
    const assistants = data.assistants;
    if (Array.isArray(assistants) && assistants.length > 0) {
      const token = assistants[0].bearerToken;
      if (typeof token === "string" && token) {
        return token;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function retireDocker(name: string): Promise<void> {
  console.log(`\u{1F5D1}\ufe0f  Stopping Docker container '${name}'...\n`);

  try {
    await exec("docker", ["stop", name]);
  } catch (error) {
    console.warn(
      `\u26a0\ufe0f  Failed to stop container: ${error instanceof Error ? error.message : error}`,
    );
  }

  try {
    await exec("docker", ["rm", name]);
  } catch (error) {
    console.warn(
      `\u26a0\ufe0f  Failed to remove container: ${error instanceof Error ? error.message : error}`,
    );
  }

  console.log(`\u2705 Docker instance retired.`);
}

export async function hatchDocker(
  species: Species,
  detached: boolean,
  name: string | null,
  watch: boolean,
): Promise<void> {
  resetLogFile("hatch.log");

  await ensureDockerInstalled();

  let repoRoot: string;
  let dockerfileDir: string;
  try {
    ({ root: repoRoot, dockerfileDir } = findDockerRoot(watch));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const logFd = openLogFile("hatch.log");
    writeToLogFile(
      logFd,
      `[docker-hatch] ${new Date().toISOString()} ERROR\n${message}\n`,
    );
    closeLogFile(logFd);
    console.error(message);
    throw err;
  }

  const instanceName = name ?? `${species}-${generateRandomSuffix()}`;
  const dockerfileName = watch ? "Dockerfile.development" : "Dockerfile";
  const dockerfile = join(dockerfileDir, dockerfileName);
  const dockerfilePath = join(repoRoot, dockerfile);

  if (!existsSync(dockerfilePath)) {
    const message = `Error: ${dockerfile} not found at ${dockerfilePath}`;
    const logFd = openLogFile("hatch.log");
    writeToLogFile(
      logFd,
      `[docker-hatch] ${new Date().toISOString()} ERROR\n${message}\n`,
    );
    closeLogFile(logFd);
    console.error(message);
    process.exit(1);
  }

  console.log(`🥚 Hatching Docker assistant: ${instanceName}`);
  console.log(`   Species: ${species}`);
  console.log(`   Dockerfile: ${dockerfile}`);
  if (watch) {
    console.log(`   Mode: development (watch)`);
  }
  console.log("");

  const imageTag = `vellum-assistant:${instanceName}`;
  const logFd = openLogFile("hatch.log");
  console.log("🔨 Building Docker image...");
  try {
    await exec("docker", ["build", "-f", dockerfile, "-t", imageTag, "."], {
      cwd: repoRoot,
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
  console.log("✅ Docker image built\n");

  const gatewayPort = DEFAULT_GATEWAY_PORT;
  const runArgs: string[] = [
    "run",
    "--init",
    "--name",
    instanceName,
    "-p",
    `${gatewayPort}:${gatewayPort}`,
  ];

  // Pass through environment variables the assistant needs
  for (const envVar of ["ANTHROPIC_API_KEY", "VELLUM_PLATFORM_URL"]) {
    if (process.env[envVar]) {
      runArgs.push("-e", `${envVar}=${process.env[envVar]}`);
    }
  }

  // Pass the instance name so the inner hatch uses the same assistant ID
  // instead of generating a new random one.
  runArgs.push("-e", `VELLUM_ASSISTANT_NAME=${instanceName}`);

  // Mount source volumes in watch mode for hot reloading
  if (watch) {
    runArgs.push(
      "-v",
      `${join(repoRoot, "assistant", "src")}:/app/assistant/src`,
      "-v",
      `${join(repoRoot, "gateway", "src")}:/app/gateway/src`,
      "-v",
      `${join(repoRoot, "cli", "src")}:/app/cli/src`,
    );
  }

  // Docker containers bind to 0.0.0.0 so localhost always works. Skip
  // mDNS/LAN discovery — the .local hostname often fails to resolve on the
  // host machine itself (mDNS is designed for cross-device discovery).
  const runtimeUrl = `http://localhost:${gatewayPort}`;
  const dockerEntry: AssistantEntry = {
    assistantId: instanceName,
    runtimeUrl,
    cloud: "docker",
    species,
    hatchedAt: new Date().toISOString(),
  };
  saveAssistantEntry(dockerEntry);
  setActiveAssistant(instanceName);

  // The Dockerfiles already define a CMD that runs `vellum hatch --keep-alive`.
  // Only override CMD when a non-default species is specified, since that
  // requires an extra argument the Dockerfile doesn't include.
  const containerCmd: string[] =
    species !== "vellum"
      ? [
          "vellum",
          "hatch",
          species,
          ...(watch ? ["--watch"] : []),
          "--keep-alive",
        ]
      : [];

  // Always start the container detached so it keeps running after the CLI exits.
  runArgs.push("-d");
  console.log("🚀 Starting Docker container...");
  await exec("docker", [...runArgs, imageTag, ...containerCmd], {
    cwd: repoRoot,
  });

  if (detached) {
    console.log("\n✅ Docker assistant hatched!\n");
    console.log("Instance details:");
    console.log(`  Name: ${instanceName}`);
    console.log(`  Runtime: ${runtimeUrl}`);
    console.log(`  Container: ${instanceName}`);
    console.log("");
    console.log(`Stop with: docker stop ${instanceName}`);
  } else {
    console.log(`  Container: ${instanceName}`);
    console.log(`  Runtime: ${runtimeUrl}`);
    console.log("");

    // Tail container logs until the inner hatch completes, then exit and
    // leave the container running in the background.
    await new Promise<void>((resolve, reject) => {
      const child = nodeSpawn("docker", ["logs", "-f", instanceName], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const handleLine = (line: string): void => {
        if (line.includes("Local assistant hatched!")) {
          process.nextTick(async () => {
            const remoteBearerToken =
              await fetchRemoteBearerToken(instanceName);
            if (remoteBearerToken) {
              dockerEntry.bearerToken = remoteBearerToken;
              saveAssistantEntry(dockerEntry);
            }

            console.log("");
            console.log(`\u2705 Docker container is up and running!`);
            console.log(`   Name: ${instanceName}`);
            console.log(`   Runtime: ${runtimeUrl}`);
            console.log("");
            child.kill();
            resolve();
          });
        }
      };

      const stdoutPrefixer = createLinePrefixer(process.stdout, handleLine);
      const stderrPrefixer = createLinePrefixer(process.stderr, handleLine);

      child.stdout?.on("data", (data: Buffer) => stdoutPrefixer.write(data));
      child.stderr?.on("data", (data: Buffer) => stderrPrefixer.write(data));
      child.stdout?.on("end", () => stdoutPrefixer.flush());
      child.stderr?.on("end", () => stderrPrefixer.flush());

      child.on("close", (code) => {
        // The log tail may exit if the container stops before the sentinel
        // is seen, or we killed it after detecting the sentinel.
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
}
