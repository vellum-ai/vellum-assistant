import { spawn as nodeSpawn } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";

import { saveAssistantEntry } from "./assistant-config";
import type { AssistantEntry } from "./assistant-config";
import { DEFAULT_GATEWAY_PORT } from "./constants";
import type { Species } from "./constants";
import { discoverPublicUrl } from "./local";
import { generateRandomSuffix } from "./random-name";
import { exec } from "./step-runner";

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
  console.log("🔨 Building Docker image...");
  await exec("docker", ["build", "-f", dockerfile, "-t", imageTag, "."], {
    cwd: repoRoot,
  });
  console.log("✅ Docker image built\n");

  const gatewayPort = DEFAULT_GATEWAY_PORT;
  const runArgs: string[] = [
    "run",
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

  if (detached) {
    runArgs.push("-d");
    console.log("🚀 Starting Docker container...");
    await exec("docker", [...runArgs, imageTag], { cwd: repoRoot });

    console.log("\n✅ Docker assistant hatched!\n");
    console.log("Instance details:");
    console.log(`  Name: ${instanceName}`);
    console.log(`  Runtime: ${runtimeUrl}`);
    console.log(`  Container: ${instanceName}`);
    console.log("");
    console.log(`Stop with: docker stop ${instanceName}`);
  } else {
    console.log("🚀 Starting Docker container (attached)...");
    console.log(`  Container: ${instanceName}`);
    console.log(`  Runtime: ${runtimeUrl}`);
    console.log("  Press Ctrl+C to stop\n");

    // Run attached with inherited stdio so the user sees container output
    await new Promise<void>((resolve, reject) => {
      const child = nodeSpawn("docker", [...runArgs, imageTag], {
        cwd: repoRoot,
        stdio: "inherit",
      });
      child.on("close", (code) => {
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`Docker container exited with code ${code}`));
        }
      });
      child.on("error", reject);
    });
  }
}
