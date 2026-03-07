import { spawn as nodeSpawn } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";

import { saveAssistantEntry, setActiveAssistant } from "./assistant-config";
import type { AssistantEntry } from "./assistant-config";
import { DEFAULT_GATEWAY_PORT } from "./constants";
import type { Species } from "./constants";
import { discoverPublicUrl } from "./local";
import { generateRandomSuffix } from "./random-name";
import { exec } from "./step-runner";
import { closeLogFile, openLogFile, writeToLogFile } from "./xdg-log";

const _require = createRequire(import.meta.url);

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
function findDockerRoot(): DockerRoot {
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
  const { root: repoRoot, dockerfileDir } = findDockerRoot();
  const instanceName = name ?? `${species}-${generateRandomSuffix()}`;
  const dockerfileName = watch ? "Dockerfile.development" : "Dockerfile";
  const dockerfile = join(dockerfileDir, dockerfileName);
  const dockerfilePath = join(repoRoot, dockerfile);

  if (!existsSync(dockerfilePath)) {
    console.error(`Error: ${dockerfile} not found at ${dockerfilePath}`);
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
    writeToLogFile(logFd, `[docker-build] ${new Date().toISOString()} ERROR\n${message}\n`);
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
  for (const envVar of [
    "ANTHROPIC_API_KEY",
    "GATEWAY_RUNTIME_PROXY_ENABLED",
    "RUNTIME_PROXY_BEARER_TOKEN",
    "VELLUM_ASSISTANT_PLATFORM_URL",
  ]) {
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

  const publicUrl = await discoverPublicUrl(gatewayPort);
  const runtimeUrl = publicUrl || `http://localhost:${gatewayPort}`;
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
      ? ["vellum", "hatch", species, ...(watch ? ["--watch"] : []), "--keep-alive"]
      : [];

  // Always start the container detached so it keeps running after the CLI exits.
  runArgs.push("-d");
  console.log("🚀 Starting Docker container...");
  await exec("docker", [...runArgs, imageTag, ...containerCmd], { cwd: repoRoot });

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
          process.nextTick(() => {
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
        if (code === 0 || code === null || code === 130 || code === 137 || code === 143) {
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
