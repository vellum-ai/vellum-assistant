import { execSync } from "child_process";
import { randomBytes } from "crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir, platform } from "os";
import { dirname, join } from "path";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../package.json";

import {
  findAssistantByName,
  loadAllAssistants,
  saveAssistantEntry,
  setActiveAssistant,
  type AssistantEntry,
  type LocalInstanceResources,
} from "./assistant-config.js";
import type { Species } from "./constants.js";
import {
  DEFAULT_CES_PORT,
  DEFAULT_DAEMON_PORT,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_QDRANT_PORT,
} from "./constants.js";
import { writeInitialConfig } from "./config-utils.js";
import { emitProgress } from "./desktop-progress.js";
import { leaseGuardianToken } from "./guardian-token.js";
import { resolveImageRefs } from "./platform-releases.js";
import { probePort } from "./port-probe.js";
import { PROVIDER_ENV_VAR_NAMES } from "../shared/provider-env-vars.js";
import { generateInstanceName } from "./random-name.js";
import { exec, execOutput } from "./step-runner.js";
import {
  closeLogFile,
  openLogFile,
  resetLogFile,
  writeToLogFile,
} from "./xdg-log.js";

const LOCAL_BIN_DIR = join(homedir(), ".local", "bin");
const SMOLVM_INSTALL_PREFIX = join(homedir(), ".smolvm");
const SMOLVM_INTERNAL_ROOT = "smolvm";
const SMOLVM_GATEWAY_PORT = 7830;
const SMOLVM_ASSISTANT_PORT = 3001;
const SMOLVM_CES_PORT = 8090;
const SMOLVM_READY_TIMEOUT_MS = 10 * 60 * 1000;
const NETWORK_ENV_VAR_NAMES = [
  "ALL_PROXY",
  "all_proxy",
  "CURL_CA_BUNDLE",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
] as const;

interface SmolvmMachineRecord {
  name: string;
  pid: number | null;
  state: string;
}

interface SmolvmHostPaths {
  cesSecurityDir: string;
  defaultConfigDir: string;
  envScriptPath: string;
  gatewaySecurityDir: string;
  logsDir: string;
  runtimeDir: string;
  smolfilePath: string;
  snapshotDir: string;
  socketDir: string;
  startupScriptPath: string;
  workspaceDir: string;
}

function ensureLocalBinOnPath(): void {
  const currentPath = process.env.PATH || "";
  const segments = [LOCAL_BIN_DIR, SMOLVM_INSTALL_PREFIX];
  const missing = segments.filter((segment) => !currentPath.includes(segment));
  if (missing.length > 0) {
    process.env.PATH = `${missing.join(":")}:${currentPath}`;
  }
}

function smolvmCandidates(): string[] {
  return [
    process.env.SMOLVM_BIN,
    join(LOCAL_BIN_DIR, "smolvm"),
    join(SMOLVM_INSTALL_PREFIX, "smolvm"),
    "smolvm",
  ].filter((candidate): candidate is string => Boolean(candidate));
}

async function isSmolvmUsable(candidate: string): Promise<boolean> {
  try {
    await execOutput(candidate, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function resolveSmolvmBinaryPath(): Promise<string> {
  ensureLocalBinOnPath();
  for (const candidate of smolvmCandidates()) {
    if (await isSmolvmUsable(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "smolvm is not installed. Run `vellum hatch --remote smolvm` to install it automatically.",
  );
}

async function ensureSmolvmInstalled(): Promise<string> {
  ensureLocalBinOnPath();

  for (const candidate of smolvmCandidates()) {
    if (await isSmolvmUsable(candidate)) {
      return candidate;
    }
  }

  const currentPlatform = platform();
  if (currentPlatform !== "darwin" && currentPlatform !== "linux") {
    throw new Error(
      "Automatic smolvm installation is only supported on macOS and Linux.",
    );
  }

  console.log("🧊 smolvm not found. Installing it locally...");
  execSync(
    `curl -fsSL https://smolmachines.com/install.sh | bash -s -- --prefix "${SMOLVM_INSTALL_PREFIX}" --no-modify-path`,
    {
      env: process.env,
      stdio: "pipe",
    },
  );

  ensureLocalBinOnPath();
  return resolveSmolvmBinaryPath();
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function runtimePaths(resources: LocalInstanceResources): SmolvmHostPaths {
  const vellumDir = join(resources.instanceDir, ".vellum");
  const runtimeDir = join(vellumDir, SMOLVM_INTERNAL_ROOT);
  return {
    cesSecurityDir: join(runtimeDir, "ces-security"),
    defaultConfigDir: join(runtimeDir, "default-config"),
    envScriptPath: join(runtimeDir, "env.sh"),
    gatewaySecurityDir: join(runtimeDir, "gateway-security"),
    logsDir: join(vellumDir, "logs"),
    runtimeDir,
    smolfilePath: join(runtimeDir, "assistant.smolfile"),
    snapshotDir: join(runtimeDir, "source-snapshot"),
    socketDir: join(runtimeDir, "socket"),
    startupScriptPath: join(runtimeDir, "start-stack.sh"),
    workspaceDir: join(vellumDir, "workspace"),
  };
}

function ensureHostDirectories(paths: SmolvmHostPaths): void {
  for (const dir of [
    paths.cesSecurityDir,
    paths.defaultConfigDir,
    paths.gatewaySecurityDir,
    paths.logsDir,
    paths.runtimeDir,
    paths.snapshotDir,
    paths.socketDir,
    paths.workspaceDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

function isRepoRoot(dir: string): boolean {
  const required = [
    join(dir, "assistant", "package.json"),
    join(dir, "gateway", "package.json"),
    join(dir, "credential-executor", "package.json"),
    join(dir, "packages", "ces-contracts", "package.json"),
    join(dir, "packages", "credential-storage", "package.json"),
    join(dir, "packages", "egress-proxy", "package.json"),
  ];
  return required.every((path) => existsSync(path));
}

function findRepoRootFrom(startDir: string): string | undefined {
  let current = startDir;
  while (true) {
    if (isRepoRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function findSmolvmSourceRepoRoot(): string {
  const candidates = [
    process.cwd(),
    import.meta.dir,
    dirname(process.execPath),
  ];

  for (const candidate of candidates) {
    const found = findRepoRootFrom(candidate);
    if (found) return found;
  }

  throw new Error(
    "smolvm hatching currently requires a full source checkout so it can snapshot the assistant stack into the VM.",
  );
}

function shouldCopyPath(srcPath: string): boolean {
  const name = srcPath.split("/").pop() ?? srcPath;
  return ![
    ".DS_Store",
    ".git",
    ".turbo",
    ".worktrees",
    "dist",
    "node_modules",
  ].includes(name);
}

function copySnapshotTree(src: string, dest: string): void {
  cpSync(src, dest, {
    dereference: false,
    filter: shouldCopyPath,
    recursive: true,
  });
}

function snapshotSourceTree(repoRoot: string, snapshotDir: string): void {
  rmSync(snapshotDir, { force: true, recursive: true });
  mkdirSync(join(snapshotDir, "packages"), { recursive: true });

  copySnapshotTree(join(repoRoot, "assistant"), join(snapshotDir, "assistant"));
  copySnapshotTree(
    join(repoRoot, "credential-executor"),
    join(snapshotDir, "credential-executor"),
  );
  copySnapshotTree(join(repoRoot, "gateway"), join(snapshotDir, "gateway"));
  copySnapshotTree(
    join(repoRoot, "packages", "ces-contracts"),
    join(snapshotDir, "packages", "ces-contracts"),
  );
  copySnapshotTree(
    join(repoRoot, "packages", "credential-storage"),
    join(snapshotDir, "packages", "credential-storage"),
  );
  copySnapshotTree(
    join(repoRoot, "packages", "egress-proxy"),
    join(snapshotDir, "packages", "egress-proxy"),
  );
}

function writeEnvScript(
  paths: SmolvmHostPaths,
  bootstrapSecret: string,
  cesServiceToken: string,
  configPath: string | null,
  instanceName: string,
  signingKey: string,
): void {
  const envEntries = new Map<string, string>();
  envEntries.set("ACTOR_TOKEN_SIGNING_KEY", signingKey);
  envEntries.set("CES_SERVICE_TOKEN", cesServiceToken);
  envEntries.set("GUARDIAN_BOOTSTRAP_SECRET", bootstrapSecret);
  envEntries.set("VELLUM_ASSISTANT_NAME", instanceName);
  if (configPath) {
    envEntries.set(
      "VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH",
      "/host-runtime/default-config/config.json",
    );
  }

  for (const envVar of [
    ...Object.values(PROVIDER_ENV_VAR_NAMES),
    ...NETWORK_ENV_VAR_NAMES,
    "VELLUM_PLATFORM_URL",
  ]) {
    if (process.env[envVar]) {
      envEntries.set(envVar, process.env[envVar]!);
    }
  }

  const lines = ["#!/usr/bin/env sh", "set -eu"];
  for (const [key, value] of envEntries) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  writeFileSync(paths.envScriptPath, `${lines.join("\n")}\n`, {
    mode: 0o600,
  });
}

function writeDefaultConfig(
  paths: SmolvmHostPaths,
  configValues: Record<string, string>,
): string | null {
  if (Object.keys(configValues).length === 0) {
    return null;
  }

  const tempPath = writeInitialConfig(configValues);
  if (!tempPath) {
    throw new Error(
      "Expected writeInitialConfig() to return a config path for non-empty config values",
    );
  }
  const configPath = join(paths.defaultConfigDir, "config.json");
  writeFileSync(configPath, readFileSync(tempPath));
  chmodSync(configPath, 0o644);
  return configPath;
}

function buildStartupScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

exec > >(tee -a /logs/startup.log) 2>&1

source /host-runtime/env.sh

BOOTSTRAP_ROOT="/srv/vellum"
BOOTSTRAP_MARKER="$BOOTSTRAP_ROOT/.bootstrap-complete"
SNAPSHOT_ROOT="/host-runtime/source-snapshot"

ensure_user() {
  local name="$1"
  local uid="$2"
  if ! id "$name" >/dev/null 2>&1; then
    useradd --system --uid "$uid" --create-home --shell /bin/bash "$name"
  fi
}

run_as() {
  local user="$1"
  shift
  local user_home
  user_home=$(eval echo "~$user")
  HOME="$user_home" USER="$user" LOGNAME="$user" SHELL=/bin/bash su -m -s /bin/bash "$user" -c "$*"
}

mkdir -p /logs /workspace /gateway-security /ces-security /run/ces-bootstrap "$BOOTSTRAP_ROOT"
chmod 777 /run/ces-bootstrap

ensure_user gateway 1002
ensure_user ces 1003

chown assistant:assistant /workspace
chown gateway:gateway /gateway-security
chown ces:ces /ces-security

if [[ ! -f "$BOOTSTRAP_MARKER" ]]; then
  echo "Bootstrapping assistant stack inside smolvm..."
  rm -rf "$BOOTSTRAP_ROOT"
  mkdir -p "$BOOTSTRAP_ROOT"
  cp -R "$SNAPSHOT_ROOT/assistant" "$BOOTSTRAP_ROOT/assistant"
  cp -R "$SNAPSHOT_ROOT/credential-executor" "$BOOTSTRAP_ROOT/credential-executor"
  cp -R "$SNAPSHOT_ROOT/gateway" "$BOOTSTRAP_ROOT/gateway"
  mkdir -p "$BOOTSTRAP_ROOT/packages"
  cp -R "$SNAPSHOT_ROOT/packages/ces-contracts" "$BOOTSTRAP_ROOT/packages/ces-contracts"
  cp -R "$SNAPSHOT_ROOT/packages/credential-storage" "$BOOTSTRAP_ROOT/packages/credential-storage"
  cp -R "$SNAPSHOT_ROOT/packages/egress-proxy" "$BOOTSTRAP_ROOT/packages/egress-proxy"

  chown -R root:root "$BOOTSTRAP_ROOT/packages"
  chown -R assistant:assistant "$BOOTSTRAP_ROOT/assistant"
  chown -R gateway:gateway "$BOOTSTRAP_ROOT/gateway"
  chown -R ces:ces "$BOOTSTRAP_ROOT/credential-executor"

  run_as assistant "cd '$BOOTSTRAP_ROOT/assistant' && bun install --frozen-lockfile"
  run_as gateway "cd '$BOOTSTRAP_ROOT/gateway' && bun install --frozen-lockfile"
  run_as ces "cd '$BOOTSTRAP_ROOT/credential-executor' && bun install --frozen-lockfile"

  touch "$BOOTSTRAP_MARKER"
fi

cleanup() {
  local exit_code=$?
  while read -r pid; do
    kill "$pid" >/dev/null 2>&1 || true
  done < <(jobs -p)
  wait || true
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

echo "Starting credential executor..."
run_as ces "cd '$BOOTSTRAP_ROOT/credential-executor' && CES_MODE=managed CES_HEALTH_PORT=${SMOLVM_CES_PORT} VELLUM_WORKSPACE_DIR=/workspace CES_BOOTSTRAP_SOCKET_DIR=/run/ces-bootstrap CREDENTIAL_SECURITY_DIR=/ces-security exec bun run src/managed-main.ts" >> /logs/credential-executor.log 2>&1 &

echo "Starting gateway..."
run_as gateway "cd '$BOOTSTRAP_ROOT/gateway' && VELLUM_WORKSPACE_DIR=/workspace GATEWAY_SECURITY_DIR=/gateway-security GATEWAY_PORT=${SMOLVM_GATEWAY_PORT} ASSISTANT_HOST=127.0.0.1 RUNTIME_HTTP_PORT=${SMOLVM_ASSISTANT_PORT} RUNTIME_PROXY_ENABLED=true CES_CREDENTIAL_URL=http://127.0.0.1:${SMOLVM_CES_PORT} exec bun run src/index.ts" >> /logs/gateway.log 2>&1 &

echo "Starting assistant..."
run_as assistant "cd '$BOOTSTRAP_ROOT/assistant' && IS_CONTAINERIZED=true VELLUM_CLOUD=smolvm RUNTIME_HTTP_HOST=0.0.0.0 RUNTIME_HTTP_PORT=${SMOLVM_ASSISTANT_PORT} VELLUM_WORKSPACE_DIR=/workspace CES_CREDENTIAL_URL=http://127.0.0.1:${SMOLVM_CES_PORT} GATEWAY_INTERNAL_URL=http://127.0.0.1:${SMOLVM_GATEWAY_PORT} exec ./docker-entrypoint.sh" >> /logs/assistant.log 2>&1 &

wait -n
`;
}

function writeStartupScript(paths: SmolvmHostPaths): void {
  writeFileSync(paths.startupScriptPath, buildStartupScript(), { mode: 0o755 });
  chmodSync(paths.startupScriptPath, 0o755);
}

function writeSmolfile(
  paths: SmolvmHostPaths,
  assistantImage: string,
  gatewayPort: number,
): void {
  const contents = [
    `image = ${tomlString(assistantImage)}`,
    `entrypoint = [${tomlString("/usr/bin/env")}, ${tomlString("bash")}, ${tomlString("/host-runtime/start-stack.sh")}]`,
    "net = true",
    "",
    "[dev]",
    "volumes = [",
    `  ${tomlString(`${paths.runtimeDir}:/host-runtime:ro`)},`,
    `  ${tomlString(`${paths.workspaceDir}:/workspace`)},`,
    `  ${tomlString(`${paths.gatewaySecurityDir}:/gateway-security`)},`,
    `  ${tomlString(`${paths.cesSecurityDir}:/ces-security`)},`,
    `  ${tomlString(`${paths.socketDir}:/run/ces-bootstrap`)},`,
    `  ${tomlString(`${paths.logsDir}:/logs`)},`,
    "]",
    "ports = [",
    `  ${tomlString(`${gatewayPort}:${SMOLVM_GATEWAY_PORT}`)},`,
    "]",
    "",
  ];
  writeFileSync(paths.smolfilePath, `${contents.join("\n")}`);
}

async function findAvailablePort(
  basePort: number,
  excludedPorts: number[],
): Promise<number> {
  for (let offset = 0; offset < 100; offset++) {
    const port = basePort + offset;
    if (excludedPorts.includes(port)) continue;
    if (!(await probePort(port))) {
      return port;
    }
  }
  throw new Error(`Could not find an available port near ${basePort}.`);
}

async function allocateSmolvmResources(
  instanceName: string,
): Promise<LocalInstanceResources> {
  const instanceDir = join(
    homedir(),
    ".local",
    "share",
    "vellum",
    "assistants",
    instanceName,
  );
  mkdirSync(instanceDir, { recursive: true });

  const reservedPorts: number[] = [];
  for (const entry of loadAllAssistants()) {
    if (!entry.resources) continue;
    reservedPorts.push(
      entry.resources.daemonPort,
      entry.resources.gatewayPort,
      entry.resources.qdrantPort,
      entry.resources.cesPort,
    );
  }

  const daemonPort = await findAvailablePort(
    DEFAULT_DAEMON_PORT,
    reservedPorts,
  );
  const gatewayPort = await findAvailablePort(DEFAULT_GATEWAY_PORT, [
    ...reservedPorts,
    daemonPort,
  ]);
  const qdrantPort = await findAvailablePort(DEFAULT_QDRANT_PORT, [
    ...reservedPorts,
    daemonPort,
    gatewayPort,
  ]);
  const cesPort = await findAvailablePort(DEFAULT_CES_PORT, [
    ...reservedPorts,
    daemonPort,
    gatewayPort,
    qdrantPort,
  ]);

  return {
    instanceDir,
    daemonPort,
    gatewayPort,
    qdrantPort,
    cesPort,
    pidFile: join(instanceDir, ".vellum", "smolvm.pid"),
  };
}

async function resolveAssistantBaseImage(
  log: (msg: string) => void,
): Promise<string> {
  const envAssistant = process.env.VELLUM_ASSISTANT_IMAGE;
  if (envAssistant) {
    log("Using assistant image override from VELLUM_ASSISTANT_IMAGE");
    return envAssistant;
  }

  const version = cliPkg.version;
  const versionTag = version ? `v${version}` : "latest";
  log("🔍 Resolving assistant base image...");
  const resolved = await resolveImageRefs(versionTag, log);
  return resolved.imageTags.assistant;
}

async function smolvmLs(): Promise<SmolvmMachineRecord[]> {
  try {
    const smolvm = await resolveSmolvmBinaryPath();
    const output = await execOutput(smolvm, ["machine", "ls", "--json"]);
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (value): value is SmolvmMachineRecord =>
          value !== null &&
          typeof value === "object" &&
          typeof (value as { name?: unknown }).name === "string" &&
          typeof (value as { state?: unknown }).state === "string",
      )
      .map((value) => ({
        name: value.name,
        pid: typeof value.pid === "number" ? value.pid : null,
        state: value.state,
      }));
  } catch {
    return [];
  }
}

export async function getSmolvmMachineState(
  machineName: string,
): Promise<string | null> {
  const machines = await smolvmLs();
  return (
    machines.find((machine) => machine.name === machineName)?.state ?? null
  );
}

export async function smolvmMachineExecOutput(
  machineName: string,
  command: string[],
): Promise<string> {
  const smolvm = await resolveSmolvmBinaryPath();
  return execOutput(smolvm, [
    "machine",
    "exec",
    "--name",
    machineName,
    "--",
    ...command,
  ]);
}

function logWriter(logFd: number | "ignore") {
  return (msg: string): void => {
    console.log(msg);
    writeToLogFile(logFd, `${new Date().toISOString()} ${msg}\n`);
  };
}

async function waitForGatewayAndLease(opts: {
  bootstrapSecret: string;
  detached: boolean;
  instanceName: string;
  logFd: number | "ignore";
  logsDir: string;
  runtimeUrl: string;
}): Promise<{ ready: boolean }> {
  const log = logWriter(opts.logFd);

  if (opts.detached) {
    log("\n✅ smolvm assistant hatched!\n");
    log("Instance details:");
    log(`  Name: ${opts.instanceName}`);
    log(`  Runtime: ${opts.runtimeUrl}`);
    log("");
    log(`Stop with: vellum retire ${opts.instanceName}`);
    return { ready: true };
  }

  log(`  Runtime: ${opts.runtimeUrl}`);
  log(`  Logs: ${opts.logsDir}`);
  log("");
  log("Waiting for assistant to become ready...");

  const readyUrl = `${opts.runtimeUrl}/readyz`;
  const start = Date.now();
  let ready = false;

  while (Date.now() - start < SMOLVM_READY_TIMEOUT_MS) {
    try {
      const resp = await fetch(readyUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        ready = true;
        break;
      }
    } catch {
      // Connection refused / timeout — not up yet.
    }

    const state = await getSmolvmMachineState(opts.instanceName);
    if (state !== null && state !== "running") {
      log(`smolvm machine state is '${state}' while waiting for readiness...`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!ready) {
    log("");
    log("   Timed out waiting for the smolvm assistant to become ready.");
    log(`   Check startup logs under: ${opts.logsDir}`);
    log("");
    return { ready: false };
  }

  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
  log(`Assistant ready after ${elapsedSec}s`);
  log(`Guardian token lease: starting for ${opts.instanceName}...`);

  const leaseStart = Date.now();
  const leaseDeadline = start + SMOLVM_READY_TIMEOUT_MS;
  let leaseSuccess = false;
  let lastLeaseError: string | undefined;

  while (Date.now() < leaseDeadline) {
    try {
      await leaseGuardianToken(
        opts.runtimeUrl,
        opts.instanceName,
        opts.bootstrapSecret,
      );
      const leaseElapsed = ((Date.now() - leaseStart) / 1000).toFixed(1);
      log(`Guardian token lease: success after ${leaseElapsed}s`);
      leaseSuccess = true;
      break;
    } catch (err) {
      lastLeaseError =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
      log(`Guardian token lease: retrying (${lastLeaseError.split("\n")[0]})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  if (!leaseSuccess) {
    log(
      `Warning: guardian token lease failed — ${lastLeaseError ?? "unknown error"}`,
    );
  }

  log("");
  log("✅ smolvm assistant is up and running!");
  log(`   Name: ${opts.instanceName}`);
  log(`   Runtime: ${opts.runtimeUrl}`);
  log("");
  return { ready: true };
}

function buildSmolvmEntry(
  instanceName: string,
  resources: LocalInstanceResources,
  species: Species,
): AssistantEntry {
  return {
    assistantId: instanceName,
    runtimeUrl: `http://localhost:${resources.gatewayPort}`,
    cloud: "smolvm",
    hatchedAt: new Date().toISOString(),
    resources,
    runtimeBackend: "smolvm",
    serviceGroupVersion: cliPkg.version ? `v${cliPkg.version}` : undefined,
    species,
  };
}

export async function hatchSmolvm(
  species: Species,
  detached: boolean,
  name: string | null,
  configValues: Record<string, string> = {},
): Promise<void> {
  resetLogFile("hatch.log");
  let logFd = openLogFile("hatch.log");
  const log = logWriter(logFd);

  try {
    emitProgress(1, 6, "Installing smolvm...");
    const smolvm = await ensureSmolvmInstalled();

    const instanceName = generateInstanceName(species, name);
    if (findAssistantByName(instanceName)) {
      throw new Error(
        `An assistant named '${instanceName}' already exists. Retire it or choose a different name.`,
      );
    }

    emitProgress(2, 6, "Preparing instance...");
    const resources = await allocateSmolvmResources(instanceName);
    const paths = runtimePaths(resources);
    ensureHostDirectories(paths);

    const repoRoot = findSmolvmSourceRepoRoot();
    snapshotSourceTree(repoRoot, paths.snapshotDir);

    const assistantImage = await resolveAssistantBaseImage(log);
    const defaultConfigPath = writeDefaultConfig(paths, configValues);

    const cesServiceToken = randomBytes(32).toString("hex");
    const signingKey = randomBytes(32).toString("hex");
    const ownSecret = randomBytes(32).toString("hex");
    const preExisting = process.env.GUARDIAN_BOOTSTRAP_SECRET;
    const bootstrapSecret = preExisting
      ? `${preExisting},${ownSecret}`
      : ownSecret;

    writeEnvScript(
      paths,
      bootstrapSecret,
      cesServiceToken,
      defaultConfigPath,
      instanceName,
      signingKey,
    );
    writeStartupScript(paths);
    writeSmolfile(paths, assistantImage, resources.gatewayPort);

    emitProgress(3, 6, "Creating machine...");
    log(`🥚 Hatching smolvm assistant: ${instanceName}`);
    log(`   Species: ${species}`);
    log(`   Base image: ${assistantImage}`);
    log(`   Runtime files: ${paths.runtimeDir}`);
    log("");

    await exec(smolvm, [
      "machine",
      "create",
      instanceName,
      "--smolfile",
      paths.smolfilePath,
    ]);

    emitProgress(4, 6, "Starting machine...");
    await exec(smolvm, ["machine", "start", "--name", instanceName]);

    const entry = buildSmolvmEntry(instanceName, resources, species);
    emitProgress(5, 6, "Saving configuration...");
    saveAssistantEntry(entry);
    setActiveAssistant(instanceName);

    emitProgress(6, 6, "Waiting for services...");
    const { ready } = await waitForGatewayAndLease({
      bootstrapSecret: ownSecret,
      detached,
      instanceName,
      logFd,
      logsDir: paths.logsDir,
      runtimeUrl: entry.runtimeUrl,
    });

    if (!ready) {
      throw new Error(
        "Timed out waiting for the smolvm assistant to become ready",
      );
    }
  } finally {
    closeLogFile(logFd);
    logFd = "ignore";
  }
}

export async function sleepSmolvm(entry: AssistantEntry): Promise<void> {
  const smolvm = await resolveSmolvmBinaryPath();
  const state = await getSmolvmMachineState(entry.assistantId);
  if (state === null || state !== "running") {
    console.log("SmolVM machine is not running.");
    return;
  }
  await exec(smolvm, ["machine", "stop", "--name", entry.assistantId]);
  console.log("SmolVM machine stopped.");
}

export async function wakeSmolvm(entry: AssistantEntry): Promise<void> {
  const smolvm = await ensureSmolvmInstalled();
  const state = await getSmolvmMachineState(entry.assistantId);
  if (state === "running") {
    console.log("SmolVM machine already running.");
    return;
  }
  await exec(smolvm, ["machine", "start", "--name", entry.assistantId]);
  console.log("SmolVM machine started.");
}

function safeRmDir(dir: string): void {
  if (!existsSync(dir)) return;
  const stats = statSync(dir);
  if (!stats.isDirectory()) return;
  rmSync(dir, { force: true, recursive: true });
}

export async function retireSmolvm(entry: AssistantEntry): Promise<void> {
  console.log(`🗑️  Retiring smolvm assistant '${entry.assistantId}'...\n`);
  const smolvm = await ensureSmolvmInstalled();
  const state = await getSmolvmMachineState(entry.assistantId);
  if (state === "running") {
    await exec(smolvm, ["machine", "stop", "--name", entry.assistantId]);
  }
  if (state !== null) {
    await exec(smolvm, ["machine", "delete", "-f", entry.assistantId]);
  }
  if (entry.resources) {
    safeRmDir(entry.resources.instanceDir);
  }
  console.log("✅ smolvm assistant retired.");
}
