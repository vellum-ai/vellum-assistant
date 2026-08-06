import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ASSISTANT_INTERNAL_PORT,
  AVATAR_DEVICE_ENV_VAR,
  collectWatchTargets,
  dockerResourceNames,
  ensureDockerDaemonRunning,
  resolveAvatarDevicePath,
  resolveDockerHatchMode,
  resolveDockerProviderCredentialSetupAction,
  type ServiceName,
} from "../docker.js";
import { buildServiceRunArgs } from "../statefulset.js";

const instanceName = "test-instance";
const imageTags: Record<ServiceName, string> = {
  assistant: "vellumai/vellum-assistant:test",
  "credential-executor": "vellumai/vellum-credential-executor:test",
  gateway: "vellumai/vellum-gateway:test",
};

function buildAssistantArgs(
  overrides: Partial<Parameters<typeof buildServiceRunArgs>[0]> = {},
): string[] {
  const res = dockerResourceNames(instanceName);
  const builders = buildServiceRunArgs({
    gatewayPort: 7830,
    assistantPort: 7821,
    imageTags,
    instanceName,
    res,
    ...overrides,
  });
  return builders.assistant();
}

function buildGatewayArgs(
  overrides: Partial<Parameters<typeof buildServiceRunArgs>[0]> = {},
): string[] {
  const res = dockerResourceNames(instanceName);
  const builders = buildServiceRunArgs({
    gatewayPort: 7830,
    assistantPort: 7821,
    imageTags,
    instanceName,
    res,
    ...overrides,
  });
  return builders.gateway();
}

describe("buildServiceRunArgs — assistant", () => {
  test("does not grant elevated capabilities or disable security profiles", () => {
    const args = buildAssistantArgs();
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--cap-add");
    expect(args).not.toContain("SYS_ADMIN");
    expect(args).not.toContain("NET_ADMIN");
    expect(args).not.toContain("seccomp=unconfined");
    expect(args).not.toContain("apparmor=unconfined");
  });

  test("does not mount a dockerd data volume", () => {
    const args = buildAssistantArgs();
    expect(args.some((a) => a.includes("/var/lib/docker"))).toBe(false);
  });

  test("does NOT bind-mount the host Docker socket", () => {
    const args = buildAssistantArgs();
    expect(args).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  test("keeps existing workspace and socket volume mounts intact", () => {
    const args = buildAssistantArgs();
    expect(args).toContain(`${instanceName}-workspace:/workspace`);
    expect(args).toContain(`${instanceName}-socket:/run/ces-bootstrap`);
  });

  test("preserves existing required env vars", () => {
    const args = buildAssistantArgs();
    expect(args).toContain("IS_CONTAINERIZED=true");
    expect(args).toContain("VELLUM_WORKSPACE_DIR=/workspace");
    expect(args).toContain(`VELLUM_ASSISTANT_NAME=${instanceName}`);
  });

  test("publishes the assistant HTTP port on all host interfaces so sibling bot containers can reach the daemon via host.docker.internal on both Docker Desktop and Linux", () => {
    const args = buildAssistantArgs({ assistantPort: 18000 });
    // The port mapping is expressed as two adjacent args: "-p" then the spec.
    // Bound to all interfaces (no `127.0.0.1:` prefix) because on vanilla
    // Linux Docker, host.docker.internal:host-gateway resolves to the Docker
    // bridge gateway IP — packets arrive at the bridge interface, not
    // loopback, so a 127.0.0.1 DNAT rule would not match.
    // The host-side port is dynamically allocated (not fixed at 7821) so
    // concurrent instances on the same host don't collide.
    const portSpec = `18000:${ASSISTANT_INTERNAL_PORT}`;
    const portIndex = args.indexOf(portSpec);
    expect(portIndex).toBeGreaterThan(0);
    expect(args[portIndex - 1]).toBe("-p");
  });

  test("forwards GUARDIAN_BOOTSTRAP_SECRET into the assistant container when provided, so the runtime can validate the gateway's x-bootstrap-secret header and close the published-port bypass", () => {
    const args = buildAssistantArgs({ bootstrapSecret: "super-secret-abc" });
    expect(args).toContain("GUARDIAN_BOOTSTRAP_SECRET=super-secret-abc");
  });

  test("omits GUARDIAN_BOOTSTRAP_SECRET when no bootstrapSecret is provided (bare-metal-style caller should not inherit a stale secret)", () => {
    const args = buildAssistantArgs();
    expect(args.some((a) => a.startsWith("GUARDIAN_BOOTSTRAP_SECRET="))).toBe(
      false,
    );
  });
});

describe("resolveDockerProviderCredentialSetupAction", () => {
  test("defers provider setup in detached mode", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: "anthropic",
        detached: true,
      }),
    ).toBe("defer");
  });

  test("reports missing guardian token only when a lease was expected", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: "anthropic",
        detached: false,
      }),
    ).toBe("missing-token");
  });

  test("configures provider setup when a guardian token is available", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: "anthropic",
        guardianAccessToken: "guardian-token",
        detached: false,
      }),
    ).toBe("configure");
  });

  test("skips provider setup for internal hatches and detached keyless hatches", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: undefined,
        detached: false,
      }),
    ).toBe("skip");
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: null,
        detached: true,
      }),
    ).toBe("skip");
  });
});

describe("buildServiceRunArgs — gateway", () => {
  const savedVelayBaseUrl = process.env.VELAY_BASE_URL;

  beforeEach(() => {
    delete process.env.VELAY_BASE_URL;
  });

  afterEach(() => {
    if (savedVelayBaseUrl === undefined) delete process.env.VELAY_BASE_URL;
    else process.env.VELAY_BASE_URL = savedVelayBaseUrl;
  });

  test("passes VELAY_BASE_URL into the gateway container when set", () => {
    process.env.VELAY_BASE_URL = "http://host.docker.internal:8501";

    expect(buildGatewayArgs()).toContain(
      "VELAY_BASE_URL=http://host.docker.internal:8501",
    );
  });

  test("omits VELAY_BASE_URL from gateway args when unset", () => {
    expect(
      buildGatewayArgs().some((arg) => arg.startsWith("VELAY_BASE_URL=")),
    ).toBe(false);
  });

  test("forces gateway to run as uid 0 so it can connect to the assistant's root-owned IPC socket (mirrors K8s securityContext.runAsUser=0)", () => {
    const args = buildGatewayArgs();
    const userIdx = args.indexOf("--user");
    expect(userIdx).toBeGreaterThan(-1);
    expect(args[userIdx + 1]).toBe("0");
  });

  test("assistant container does NOT get a --user override (image USER root wins)", () => {
    expect(buildAssistantArgs().includes("--user")).toBe(false);
  });
});

describe("VELLUM_AVATAR_DEVICE passthrough", () => {
  const savedValue = process.env[AVATAR_DEVICE_ENV_VAR];

  beforeEach(() => {
    delete process.env[AVATAR_DEVICE_ENV_VAR];
  });

  afterEach(() => {
    if (savedValue === undefined) delete process.env[AVATAR_DEVICE_ENV_VAR];
    else process.env[AVATAR_DEVICE_ENV_VAR] = savedValue;
  });

  test("resolveAvatarDevicePath returns default when env var is unset", () => {
    expect(resolveAvatarDevicePath({})).toBe("/dev/video10");
  });

  test("resolveAvatarDevicePath honors override", () => {
    expect(
      resolveAvatarDevicePath({ [AVATAR_DEVICE_ENV_VAR]: "/dev/video11" }),
    ).toBe("/dev/video11");
  });

  test("assistant args omit --device and env var when device node is absent", () => {
    const args = buildAssistantArgs();
    expect(args).not.toContain("--device");
    expect(args.some((a) => a.startsWith(`${AVATAR_DEVICE_ENV_VAR}=`))).toBe(
      false,
    );
  });
});

describe("resolveDockerHatchMode", () => {
  test("defaults to pulling published images when no source flag is set", () => {
    expect(
      resolveDockerHatchMode({
        watch: false,
        buildFromSource: false,
        fullSourceTreeAvailable: true,
      }),
    ).toEqual({ build: false, watcher: false, fellBackToPull: false });
  });

  test("--source <path> builds without enabling the file watcher", () => {
    expect(
      resolveDockerHatchMode({
        watch: false,
        buildFromSource: true,
        fullSourceTreeAvailable: true,
      }),
    ).toEqual({ build: true, watcher: false, fellBackToPull: false });
  });

  test("--watch builds and enables the file watcher", () => {
    expect(
      resolveDockerHatchMode({
        watch: true,
        buildFromSource: false,
        fullSourceTreeAvailable: true,
      }),
    ).toEqual({ build: true, watcher: true, fellBackToPull: false });
  });

  test("--watch + --source <path> still enables the watcher (watch wins)", () => {
    expect(
      resolveDockerHatchMode({
        watch: true,
        buildFromSource: true,
        fullSourceTreeAvailable: true,
      }),
    ).toEqual({ build: true, watcher: true, fellBackToPull: false });
  });

  test("falls back to pull when source flag is set but source tree is missing", () => {
    expect(
      resolveDockerHatchMode({
        watch: false,
        buildFromSource: true,
        fullSourceTreeAvailable: false,
      }),
    ).toEqual({ build: false, watcher: false, fellBackToPull: true });
    expect(
      resolveDockerHatchMode({
        watch: true,
        buildFromSource: false,
        fullSourceTreeAvailable: false,
      }),
    ).toEqual({ build: false, watcher: false, fellBackToPull: true });
  });
});

describe("collectWatchTargets", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "vellum-watch-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function scaffold(
    relDir: string,
    { src = true, pkg = true, dockerfile = false } = {},
  ): void {
    mkdirSync(join(repoRoot, relDir), { recursive: true });
    if (src) mkdirSync(join(repoRoot, relDir, "src"), { recursive: true });
    if (pkg) writeFileSync(join(repoRoot, relDir, "package.json"), "{}");
    if (dockerfile) writeFileSync(join(repoRoot, relDir, "Dockerfile"), "");
  }

  test("scopes watch targets to src/, package.json, and the Dockerfile", () => {
    // GIVEN the three services (each with a Dockerfile) plus a couple of
    // shared packages (libraries, no Dockerfile)
    scaffold("assistant", { dockerfile: true });
    scaffold("credential-executor", { dockerfile: true });
    scaffold("gateway", { dockerfile: true });
    scaffold("packages/service-contracts");
    scaffold("packages/local-mode");

    // WHEN we collect the watch targets
    const { dirs, files } = collectWatchTargets(repoRoot);

    // THEN only the src/ directories are watched recursively
    expect(dirs.sort()).toEqual(
      [
        join(repoRoot, "assistant", "src"),
        join(repoRoot, "credential-executor", "src"),
        join(repoRoot, "gateway", "src"),
        join(repoRoot, "packages", "local-mode", "src"),
        join(repoRoot, "packages", "service-contracts", "src"),
      ].sort(),
    );

    // AND the package.json manifests and service Dockerfiles are watched as
    // individual files (packages have no Dockerfile, so none is emitted)
    expect(files.sort()).toEqual(
      [
        join(repoRoot, "assistant", "package.json"),
        join(repoRoot, "assistant", "Dockerfile"),
        join(repoRoot, "credential-executor", "package.json"),
        join(repoRoot, "credential-executor", "Dockerfile"),
        join(repoRoot, "gateway", "package.json"),
        join(repoRoot, "gateway", "Dockerfile"),
        join(repoRoot, "packages", "local-mode", "package.json"),
        join(repoRoot, "packages", "service-contracts", "package.json"),
      ].sort(),
    );
  });

  test("never watches .claude/ command symlinks that crash the watcher", () => {
    // GIVEN an assistant service whose .claude/commands holds a dangling
    // symlink (as it does in a fresh checkout)
    scaffold("assistant");
    mkdirSync(join(repoRoot, "assistant", ".claude", "commands"), {
      recursive: true,
    });
    symlinkSync(
      join(repoRoot, "does-not-exist", "do.md"),
      join(repoRoot, "assistant", ".claude", "commands", "do.md"),
    );

    // WHEN we collect the watch targets
    const { dirs, files } = collectWatchTargets(repoRoot);

    // THEN no watched path reaches into the .claude/ tree
    const all = [...dirs, ...files];
    expect(all.some((p) => p.includes(".claude"))).toBe(false);
    expect(dirs).toContain(join(repoRoot, "assistant", "src"));
  });

  test("skips roots missing a src/ directory or package.json", () => {
    // GIVEN a service with only a manifest and a package with only a src/ dir
    scaffold("gateway", { src: false, pkg: true });
    scaffold("packages/contracts-only", { src: true, pkg: false });

    // WHEN we collect the watch targets
    const { dirs, files } = collectWatchTargets(repoRoot);

    // THEN absent paths are not emitted
    expect(dirs).toEqual([join(repoRoot, "packages", "contracts-only", "src")]);
    expect(files).toEqual([join(repoRoot, "gateway", "package.json")]);
  });
});

/**
 * Build a fake `exec` that records calls and fails the probes named in `fail`.
 * Injected into `ensureDockerDaemonRunning` so these cases need no `mock.module`
 * (which is process-global and would leak across the CLI's single-process test
 * run) and no real Docker/Colima subprocesses.
 */
function fakeExec(fail: { dockerInfo?: boolean; colimaStatus?: boolean }) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec = async (cmd: string, args: string[] = []): Promise<void> => {
    calls.push({ cmd, args });
    if (cmd === "docker" && args[0] === "info" && fail.dockerInfo) {
      throw new Error("Cannot connect to the Docker daemon");
    }
    if (cmd === "colima" && args[0] === "status" && fail.colimaStatus) {
      throw new Error("colima is not running");
    }
  };
  const ran = (cmd: string, sub: string): boolean =>
    calls.some((c) => c.cmd === cmd && c.args[0] === sub);
  return { exec: exec as typeof import("../step-runner.js").exec, ran };
}

describe("ensureDockerDaemonRunning", () => {
  // Regression: waking an instance hatched under Docker Desktop must NOT start
  // Colima, because that switches the active `docker context` and points
  // `docker start` at a VM that never held the instance's containers.
  test("reuses an already-reachable daemon (e.g. Docker Desktop) and never touches Colima", async () => {
    const { exec, ran } = fakeExec({ dockerInfo: false });

    await ensureDockerDaemonRunning(exec);

    expect(ran("docker", "info")).toBe(true);
    expect(ran("colima", "status")).toBe(false);
    expect(ran("colima", "start")).toBe(false);
  });

  test("starts Colima only when no daemon is reachable", async () => {
    const { exec, ran } = fakeExec({ dockerInfo: true, colimaStatus: true });

    await ensureDockerDaemonRunning(exec);

    expect(ran("docker", "info")).toBe(true);
    expect(ran("colima", "start")).toBe(true);
  });

  test("does not restart Colima when it is already running", async () => {
    const { exec, ran } = fakeExec({ dockerInfo: true, colimaStatus: false });

    await ensureDockerDaemonRunning(exec);

    expect(ran("colima", "status")).toBe(true);
    expect(ran("colima", "start")).toBe(false);
  });
});
