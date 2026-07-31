#!/usr/bin/env bun

import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const repoRoot = resolve(import.meta.dir, "..");
const cliDir = join(repoRoot, "cli");
const metaDir = join(repoRoot, "meta");
const workspaceRoot = await realpath(repoRoot);
const tempRoot = await mkdtemp(join(tmpdir(), "vellum-cli-package-install-"));
const distDir = join(tempRoot, "dist");
const wrapperDir = join(tempRoot, "wrapper");
const fakeBinDir = join(tempRoot, "fake-bin");
const installPrefix = join(tempRoot, "bun-prefix");
const executionDir = join(tempRoot, "execution");
const runtimeDir = join(tempRoot, "runtime");
const configDir = join(tempRoot, "config");

try {
  await Promise.all(
    [distDir, wrapperDir, fakeBinDir, executionDir, runtimeDir, configDir].map(
      async (directory) => await mkdir(directory, { recursive: true }),
    ),
  );

  const packCli = await run(["bun", "pm", "pack", "--destination", distDir], {
    cwd: cliDir,
  });
  requireSuccess(packCli, "pack @vellumai/cli");
  const cliTarball = await findSingleTarball(distDir);

  const rewriteBundleManifest = await run(
    [
      "bun",
      join(repoRoot, "scripts", "strip-bundled-field-from-tarball.mjs"),
      cliTarball,
    ],
    { cwd: repoRoot },
  );
  requireSuccess(
    rewriteBundleManifest,
    "rewrite bundled workspace dependency paths",
  );
  await verifyBundledWorkspacePackages(cliTarball);

  await stageWrapper(cliTarball);
  const packWrapper = await run(
    ["bun", "pm", "pack", "--destination", distDir],
    {
      cwd: wrapperDir,
    },
  );
  requireSuccess(packWrapper, "pack vellum wrapper");
  const wrapperTarball = await findSingleTarball(distDir, cliTarball);

  const bunBinDir = dirname(process.execPath);
  const installEnv = {
    ...process.env,
    BUN_INSTALL: installPrefix,
    PATH: [fakeBinDir, bunBinDir, "/usr/local/bin", "/usr/bin", "/bin"].join(
      ":",
    ),
    XDG_CONFIG_HOME: configDir,
    XDG_RUNTIME_DIR: runtimeDir,
    NODE_PATH: "",
  };
  const install = await run(["bun", "install", "--global", wrapperTarball], {
    cwd: executionDir,
    env: installEnv,
  });
  requireSuccess(install, "install staged vellum wrapper");

  const vellumBin = join(installPrefix, "bin", "vellum");
  const installedWrapper = await realpath(vellumBin);
  assertOutsideWorkspace(installedWrapper, "installed wrapper");
  await verifyInstalledCli(installPrefix);
  await installFakeAudioCommands();

  const server = startFakeVoiceServer();
  try {
    const help = await run([vellumBin, "voice", "--help"], {
      cwd: executionDir,
      env: installEnv,
    });
    requireSuccess(help, "invoke installed voice help");
    assertIncludes(help.stdout, "Usage: vellum voice", "voice help");
    assertNoWorkspaceFallback(help, "voice help");

    const devices = await run([vellumBin, "voice", "devices", "--json"], {
      cwd: executionDir,
      env: installEnv,
    });
    requireSuccess(devices, "invoke installed voice device discovery");
    const devicesReport = parseJson(devices.stdout, "voice devices");
    assertDeviceReport(devicesReport);
    assertNoWorkspaceFallback(devices, "voice devices");

    const doctor = await run(
      [
        vellumBin,
        "voice",
        "doctor",
        "--url",
        `http://127.0.0.1:${server.port}`,
        "--assistant-id",
        "assistant-123",
        "--json",
      ],
      { cwd: executionDir, env: installEnv },
    );
    const doctorReport = parseJson(doctor.stdout, "voice doctor");
    assertDoctorReport(doctorReport, doctor.exitCode);
    assertNoWorkspaceFallback(doctor, "voice doctor");
  } finally {
    server.stop(true);
  }

  console.log(
    `Installed wrapper verification passed on ${process.platform} ${process.arch}.`,
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function stageWrapper(cliTarball: string): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(metaDir, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  await mkdir(join(wrapperDir, "bin"), { recursive: true });
  await cp(
    join(metaDir, "bin", "vellum.js"),
    join(wrapperDir, "bin", "vellum.js"),
  );
  await chmod(join(wrapperDir, "bin", "vellum.js"), 0o755);
  await writeFile(
    join(wrapperDir, "package.json"),
    `${JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        license: manifest.license,
        description: manifest.description,
        bin: { vellum: "./bin/vellum.js" },
        files: ["bin"],
        dependencies: {
          "@vellumai/cli": `file:${cliTarball}`,
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function verifyBundledWorkspacePackages(
  cliTarball: string,
): Promise<void> {
  const listing = await run(["tar", "-tzf", cliTarball], { cwd: repoRoot });
  requireSuccess(listing, "inspect @vellumai/cli tarball");
  for (const packageName of [
    "environments",
    "local-mode",
    "service-contracts",
  ]) {
    assertIncludes(
      listing.stdout,
      `package/node_modules/@vellumai/${packageName}/package.json`,
      `bundled @vellumai/${packageName}`,
    );
  }
}

async function verifyInstalledCli(prefix: string): Promise<void> {
  const matches: string[] = [];
  const glob = new Bun.Glob("**/node_modules/@vellumai/cli/package.json");
  for await (const match of glob.scan({
    cwd: prefix,
    absolute: true,
    onlyFiles: true,
  })) {
    matches.push(await realpath(match));
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected one installed @vellumai/cli package, found ${matches.length}.`,
    );
  }
  assertOutsideWorkspace(matches[0], "installed @vellumai/cli");
  const cliPackageDir = dirname(matches[0]);
  for (const packageName of [
    "environments",
    "local-mode",
    "service-contracts",
  ]) {
    const manifest = await realpath(
      join(
        cliPackageDir,
        "node_modules",
        "@vellumai",
        packageName,
        "package.json",
      ),
    );
    assertOutsideWorkspace(manifest, `installed @vellumai/${packageName}`);
  }
}

async function installFakeAudioCommands(): Promise<void> {
  const pipeWireDump = JSON.stringify([
    {
      id: 11,
      type: "PipeWire:Interface:Node",
      info: {
        props: {
          "node.name": "test_microphone",
          "node.description": "Package install test microphone",
          "media.class": "Audio/Source",
          "object.serial": 101,
        },
      },
    },
    {
      id: 12,
      type: "PipeWire:Interface:Node",
      info: {
        props: {
          "node.name": "test_speakers",
          "node.description": "Package install test speakers",
          "media.class": "Audio/Sink",
          "object.serial": 102,
        },
      },
    },
  ]);
  await writeExecutable(
    "pw-dump",
    `#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(pipeWireDump)} + "\\n");\n`,
  );
  await writeExecutable(
    "pw-record",
    `#!/usr/bin/env bun\nif (process.argv.includes("--version")) {\n  console.log("pw-record 1.4.2");\n  process.exit(0);\n}\nprocess.stdout.write(Buffer.alloc(320));\nsetInterval(() => {}, 1000);\n`,
  );
  await writeExecutable(
    "pw-play",
    "#!/usr/bin/env bun\nfor await (const _chunk of Bun.stdin.stream()) {\n}\n",
  );
  await writeExecutable(
    "systemctl",
    '#!/usr/bin/env bun\nconsole.log("active");\n',
  );
  await writeExecutable(
    "loginctl",
    '#!/usr/bin/env bun\nconsole.log("Linger=yes");\n',
  );
}

async function writeExecutable(name: string, contents: string): Promise<void> {
  const path = join(fakeBinDir, name);
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

function startFakeVoiceServer(): ReturnType<typeof Bun.serve> {
  let seq = 0;
  return Bun.serve({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/live-voice/preflight") {
        return Response.json({ status: "ready" });
      }
      if (url.pathname === "/v1/live-voice" && server.upgrade(request)) {
        return;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(socket, message) {
        if (typeof message !== "string") {
          return;
        }
        const frame = JSON.parse(message) as { type?: unknown };
        if (frame.type === "start") {
          socket.send(
            JSON.stringify({
              type: "ready",
              seq: ++seq,
              sessionId: "session-123",
              conversationId: "conversation-123",
              turnDetection: "manual",
            }),
          );
        } else if (frame.type === "end") {
          socket.send(
            JSON.stringify({
              type: "session_released",
              seq: ++seq,
              sessionId: "session-123",
            }),
          );
        }
      },
    },
  });
}

async function run(
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
): Promise<CommandResult> {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function findSingleTarball(
  directory: string,
  excluded?: string,
): Promise<string> {
  const matches: string[] = [];
  const glob = new Bun.Glob("*.tgz");
  for await (const match of glob.scan({
    cwd: directory,
    absolute: true,
    onlyFiles: true,
  })) {
    if (excluded === undefined || resolve(match) !== resolve(excluded)) {
      matches.push(match);
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected one tarball in ${relative(repoRoot, directory)}, found ${matches.length}.`,
    );
  }
  return matches[0];
}

function requireSuccess(result: CommandResult, operation: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${operation} failed with exit ${result.exitCode}.\n${result.stdout}${result.stderr}`,
    );
  }
}

function parseJson(output: string, operation: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`${operation} did not return a JSON object.`);
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${operation} did not return a JSON object.`);
}

function assertDeviceReport(report: Record<string, unknown>): void {
  if (
    !Array.isArray(report.inputs) ||
    report.inputs.length !== 1 ||
    !Array.isArray(report.outputs) ||
    report.outputs.length !== 1
  ) {
    throw new Error("Installed voice device discovery returned bad fixtures.");
  }
}

function assertDoctorReport(
  report: Record<string, unknown>,
  exitCode: number,
): void {
  const target = report.target as Record<string, unknown> | undefined;
  const audio = report.audio as Record<string, unknown> | undefined;
  if (target?.status !== "ready" || !Array.isArray(audio?.checks)) {
    throw new Error("Installed voice doctor did not reach the fake assistant.");
  }
  const supportedHost =
    process.platform === "linux" && process.arch === "arm64";
  if (supportedHost && (exitCode !== 0 || report.ok !== true)) {
    throw new Error("Installed voice doctor failed on native Linux ARM64.");
  }
  if (!supportedHost && exitCode === 0) {
    throw new Error("Voice doctor unexpectedly accepted an unsupported host.");
  }
}

function assertOutsideWorkspace(path: string, label: string): void {
  if (path === workspaceRoot || path.startsWith(`${workspaceRoot}/`)) {
    throw new Error(`${label} resolved into the repository workspace.`);
  }
}

function assertNoWorkspaceFallback(
  result: CommandResult,
  operation: string,
): void {
  if (`${result.stdout}\n${result.stderr}`.includes(workspaceRoot)) {
    throw new Error(`${operation} exposed a repository workspace fallback.`);
  }
}

function assertIncludes(value: string, expected: string, label: string): void {
  if (!value.includes(expected)) {
    throw new Error(`${label} did not include '${expected}'.`);
  }
}
