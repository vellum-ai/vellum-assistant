import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsModule from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import * as featureFlags from "../lib/feature-flags.js";
import * as httpClient from "../lib/http-client.js";

const realChildProcess = { ...childProcess };
const realFs = { ...fsModule };
const realFeatureFlags = { ...featureFlags };
const realHttpClient = { ...httpClient };

const execFileSyncMock = mock(childProcess.execFileSync);
const spawnSyncMock = mock(childProcess.spawnSync);
const spawnMock = mock(childProcess.spawn);

mock.module("node:child_process", () => ({
  ...childProcess,
  execFileSync: execFileSyncMock,
  spawnSync: spawnSyncMock,
  spawn: spawnMock,
}));

const existsSyncMock = mock(fsModule.existsSync);
const readFileSyncMock = mock(fsModule.readFileSync);

mock.module("node:fs", () => ({
  ...fsModule,
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));

const waitForDaemonReadyMock = mock<typeof httpClient.waitForDaemonReady>(
  async () => true,
);

mock.module("../lib/http-client.js", () => ({
  ...httpClient,
  waitForDaemonReady: waitForDaemonReadyMock,
}));

const isFeatureFlagEnabledMock = mock<
  typeof featureFlags.isAssistantFeatureFlagEnabled
>(async () => true);

mock.module("../lib/feature-flags.js", () => ({
  ...featureFlags,
  isAssistantFeatureFlagEnabled: isFeatureFlagEnabledMock,
}));

// Restore the real modules once this file finishes so the mocks do not leak
// into sibling test files in the same `bun test` run.
afterAll(() => {
  mock.module("node:child_process", () => realChildProcess);
  mock.module("node:fs", () => realFs);
  mock.module("../lib/feature-flags.js", () => realFeatureFlags);
  mock.module("../lib/http-client.js", () => realHttpClient);
});

import {
  buildIngressNginxConfig,
  hasIpv6Loopback,
  buildRemoteWebIndexHtml,
  cloudWebHubUrl,
  ensureTunnelEdge,
  startRemoteWebIngress,
  stopIngressNginx,
} from "../lib/nginx-ingress.js";

const originalKill = process.kill;
const workspaces: string[] = [];

/**
 * Registry-backed process.kill mock: registered fake PIDs answer liveness
 * probes and record kills, everything else forwards to the real kill. Lets
 * helpers compose (old-edge PID and freshly-spawned master PID at once).
 */
const fakePids = new Map<number, { alive: boolean; unkillable?: boolean }>();

function installKillMock(): void {
  process.kill = mock((targetPid: number, signal?: string | number) => {
    const entry = fakePids.get(targetPid);
    if (!entry) {
      return originalKill(targetPid, signal);
    }
    if (signal === 0) {
      if (!entry.alive) {
        throw new Error("dead");
      }
      return true;
    }
    if (entry.unkillable) {
      throw new Error("operation not permitted");
    }
    entry.alive = false;
    return true;
  }) as unknown as typeof process.kill;
}

afterEach(() => {
  process.kill = originalKill;
  fakePids.clear();
  execFileSyncMock.mockReset();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation(realChildProcess.spawnSync);
  spawnMock.mockReset();
  spawnMock.mockImplementation(realChildProcess.spawn);
  existsSyncMock.mockReset();
  existsSyncMock.mockImplementation(realFs.existsSync);
  readFileSyncMock.mockReset();
  readFileSyncMock.mockImplementation(realFs.readFileSync);
  waitForDaemonReadyMock.mockReset();
  waitForDaemonReadyMock.mockImplementation(async () => true);
  isFeatureFlagEnabledMock.mockReset();
  isFeatureFlagEnabledMock.mockImplementation(async () => true);
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "vellum-ingress-test-"));
  workspaces.push(dir);
  return dir;
}

function readConfig(workspaceDir: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(workspaceDir, "config.json"), "utf-8"),
  ) as Record<string, unknown>;
}

describe("buildIngressNginxConfig", () => {
  const conf = buildIngressNginxConfig({ gatewayPort: 7830, listenPort: 7840 });
  const remoteConf = buildIngressNginxConfig({
    gatewayPort: 7830,
    listenPort: 7840,
    remoteWebIngress: {
      webDistDir: "/tmp/vellum web/dist",
      config: {
        mode: "remote-gateway",
        apiBaseUrl: "/v1",
        platformDisabled: true,
      },
    },
  });

  test("listens on loopback only", () => {
    expect(conf).toContain("listen 127.0.0.1:7840;");
    const listens = conf.match(/listen [^;]+;/g) ?? [];
    expect(listens.length).toBeGreaterThan(0);
    for (const directive of listens) {
      expect(directive).toMatch(/127\.0\.0\.1|\[::1\]/);
    }
  });

  test("adds the IPv6 loopback listener only where ::1 exists", () => {
    // A tunnel agent pointed at "localhost" reaches ::1 first on macOS, so an
    // IPv4-only bind refuses whichever share of a burst resolves that way.
    // Emitting it unconditionally would make nginx exit on an IPv6-less host.
    const withIpv6 = buildIngressNginxConfig({
      gatewayPort: 7830,
      listenPort: 7840,
      ipv6Loopback: true,
    });
    expect(withIpv6).toContain("listen 127.0.0.1:7840;");
    expect(withIpv6).toContain("listen [::1]:7840;");

    expect(conf).not.toContain("[::1]");
  });

  test("emits relative redirects so a fronting proxy keeps scheme and port", () => {
    for (const config of [conf, remoteConf]) {
      expect(config).toContain("absolute_redirect off;");
      expect(config).toContain("port_in_redirect off;");
    }
  });

  test("proxies requests to the gateway", () => {
    expect(conf).toContain("location / {");
    expect(conf).toContain("proxy_pass http://127.0.0.1:7830;");
    expect(conf).toContain('proxy_set_header X-Vellum-Edge-Forwarded "1";');
  });

  test("blocks local-only bootstrap helpers before the catch-all proxy", () => {
    const catchAll = conf.indexOf("location / {");
    expect(catchAll).toBeGreaterThan(-1);
    const deniedLocations = [
      "location = /auth/token { return 404; }",
      "location = /v1/pair { return 404; }",
      "location = /v1/guardian/init { return 404; }",
      "location = /v1/remote-web/pairing-verification { return 404; }",
    ];
    for (const location of deniedLocations) {
      expect(conf).toContain(location);
      expect(conf.indexOf(location)).toBeLessThan(catchAll);
    }
  });

  test("declares static MIME types needed by the SPA", () => {
    expect(remoteConf).toContain("default_type application/octet-stream;");
    expect(remoteConf).toContain("types {");
    expect(remoteConf).toContain("application/javascript js mjs;");
    expect(remoteConf).toContain("text/css css;");
    expect(remoteConf).toContain("text/html html htm;");
    expect(remoteConf).toContain("font/woff2 woff2;");
    expect(remoteConf).toContain("image/svg+xml svg svgz;");
  });

  test("serves the remote web SPA from /assistant when configured", () => {
    expect(remoteConf).toContain("location = / {");
    expect(remoteConf).toContain("return 302 /assistant/;");
    expect(remoteConf.indexOf("location = / {")).toBeLessThan(
      remoteConf.indexOf("location / {"),
    );
    expect(remoteConf).toContain("location = /assistant {");
    expect(remoteConf).toContain("return 302 /assistant/;");
    expect(remoteConf).toContain("location ^~ /assistant/assets/ {");
    expect(remoteConf).toContain('alias "/tmp/vellum web/dist/assets/";');
    expect(remoteConf).toContain("try_files $uri =404;");
    expect(remoteConf).toContain("location = /assistant/ {");
    expect(remoteConf).toContain(
      "rewrite ^ /assistant/__remote-index.html last;",
    );
    expect(remoteConf).toContain("location = /assistant/index.html {");
    expect(remoteConf).toContain("location = /assistant/__remote-index.html {");
    expect(remoteConf).toContain("internal;");
    expect(remoteConf).toContain('alias "/tmp/vellum web/dist/index.html";');
    expect(remoteConf).toContain("location ^~ /assistant/ {");
    expect(remoteConf).toContain('alias "/tmp/vellum web/dist/";');
    expect(remoteConf).toContain(
      "try_files $uri $uri/ /assistant/__remote-index.html;",
    );
    expect(remoteConf).toContain("location / {\n      return 404;\n    }");
  });

  test("serves remote web config for the SPA", () => {
    expect(remoteConf).toContain("location = /assistant/__config {");
    expect(remoteConf).toContain("default_type application/json;");
    expect(remoteConf).toContain('add_header Cache-Control "no-store";');
    expect(remoteConf).toContain(
      'return 200 "{\\"mode\\":\\"remote-gateway\\",\\"apiBaseUrl\\":\\"/v1\\",\\"platformDisabled\\":true,\\"disablePlatform\\":true}";',
    );
  });

  test("stamps assistantName and hubUrl into the served config when provided", () => {
    const named = buildIngressNginxConfig({
      gatewayPort: 7830,
      listenPort: 7840,
      remoteWebIngress: {
        webDistDir: "/tmp/vellum web/dist",
        assistantName: "Homelab",
        hubUrl: "https://www.vellum.ai/assistant",
      },
    });
    expect(named).toContain(
      'return 200 "{\\"mode\\":\\"remote-gateway\\",\\"apiBaseUrl\\":\\"/v1\\",\\"platformDisabled\\":true,\\"disablePlatform\\":true,\\"assistantName\\":\\"Homelab\\",\\"hubUrl\\":\\"https://www.vellum.ai/assistant\\"}";',
    );
  });

  test("proxies health and public API traffic to the gateway in remote web mode", () => {
    expect(remoteConf).toContain("location = /healthz {");
    expect(remoteConf).toContain("location ^~ /v1/ {");
    expect(remoteConf).toContain("proxy_pass http://127.0.0.1:7830;");
    expect(remoteConf).toContain("proxy_request_buffering off;");
    expect(remoteConf).toContain("proxy_buffering off;");
    expect(remoteConf).toContain(
      'proxy_set_header X-Vellum-Edge-Forwarded "1";',
    );
  });

  test("proxies webhook callbacks to the gateway in remote web mode", () => {
    const webhooksStart = remoteConf.indexOf("location ^~ /webhooks/ {");
    expect(webhooksStart).toBeGreaterThan(-1);
    const webhooksBlock = remoteConf.slice(
      webhooksStart,
      remoteConf.indexOf("}", webhooksStart),
    );
    expect(webhooksBlock).toContain("proxy_pass http://127.0.0.1:7830;");
    expect(webhooksBlock).toContain("proxy_set_header Upgrade $http_upgrade;");
  });

  test("proxies /healthz in both modes", () => {
    expect(remoteConf).toContain("location = /healthz {");
    // The plain-proxy mode has no /healthz denylist entry, so the catch-all
    // proxy serves it.
    expect(conf).not.toContain("/healthz { return 404; }");
    expect(conf).toContain("location / {");
    expect(conf).toContain("proxy_pass http://127.0.0.1:7830;");
  });

  test("blocks local-only bootstrap helpers before generic API proxying", () => {
    const deniedLocations = [
      "location = /auth/token { return 404; }",
      "location = /auth/token/ { return 404; }",
      "location = /v1/pair { return 404; }",
      "location = /v1/pair/ { return 404; }",
      "location = /v1/pair/web-init { return 404; }",
      "location = /v1/pair/web-init/ { return 404; }",
      "location = /v1/devices { return 404; }",
      "location = /v1/devices/ { return 404; }",
      "location = /v1/devices/revoke { return 404; }",
      "location = /v1/devices/revoke/ { return 404; }",
      "location = /v1/guardian/init { return 404; }",
      "location = /v1/guardian/init/ { return 404; }",
      "location = /v1/guardian/reset-bootstrap { return 404; }",
      "location = /v1/guardian/reset-bootstrap/ { return 404; }",
      "location ^~ /assistant/__local/ { return 404; }",
      "location ^~ /assistant/__gateway/ { return 404; }",
      "location ^~ /assistant/__gateway-paired/ { return 404; }",
    ];
    for (const location of deniedLocations) {
      expect(remoteConf).toContain(location);
      expect(remoteConf.indexOf(location)).toBeLessThan(
        remoteConf.indexOf("location ^~ /v1/ {"),
      );
    }
  });

  test("supports websockets and SSE streaming", () => {
    expect(conf).toContain("map $http_upgrade $connection_upgrade");
    expect(conf).toContain("proxy_http_version 1.1;");
    expect(conf).toContain("proxy_set_header Upgrade $http_upgrade;");
    expect(conf).toContain("proxy_set_header Connection $connection_upgrade;");
    expect(conf).toContain("proxy_request_buffering off;");
    expect(conf).toContain("proxy_buffering off;");
    expect(conf).toContain("proxy_read_timeout 1h;");
  });
});

describe("buildRemoteWebIndexHtml", () => {
  test("injects the remote gateway config after any bundled local config", () => {
    const html =
      '<html><head><script>window.__VELLUM_CONFIG__={"webUrl":"https://www.vellum.ai"}</script></head><body></body></html>';
    const result = buildRemoteWebIndexHtml(html, {
      mode: "remote-gateway",
      apiBaseUrl: "/v1",
      disablePlatform: true,
    });

    expect(result).toContain(
      'window.__VELLUM_CONFIG__={"webUrl":"https://www.vellum.ai"}',
    );
    expect(result).toContain(
      'window.__VELLUM_CONFIG__={"mode":"remote-gateway","apiBaseUrl":"/v1","disablePlatform":true}',
    );
    expect(result.indexOf('"webUrl"')).toBeLessThan(
      result.indexOf('"remote-gateway"'),
    );
  });

  test("escapes config JSON before embedding it in a script tag", () => {
    const result = buildRemoteWebIndexHtml("</head>", {
      value: "</script><script>alert(1)</script>",
    });

    expect(result).not.toContain("</script><script>alert(1)</script>");
    expect(result).toContain("\\u003c/script\\u003e");
  });

  test("drops modulepreload hints but keeps the entry script and stylesheet", () => {
    const html = [
      "<html><head>",
      '<link rel="modulepreload" crossorigin href="/assistant/assets/a-1.js">',
      '<link rel="modulepreload" crossorigin href="/assistant/assets/b-2.js">',
      '<link rel="stylesheet" crossorigin href="/assistant/assets/main-3.css">',
      '<script type="module" crossorigin src="/assistant/assets/index-4.js"></script>',
      "</head><body></body></html>",
    ].join("\n");

    const result = buildRemoteWebIndexHtml(html, { mode: "remote-gateway" });

    expect(result).not.toContain("modulepreload");
    expect(result).not.toContain("/assistant/assets/a-1.js");
    expect(result).toContain('href="/assistant/assets/main-3.css"');
    expect(result).toContain('src="/assistant/assets/index-4.js"');
  });
});

describe("cloudWebHubUrl", () => {
  test("maps build environments to their cloud SPA base", () => {
    expect(cloudWebHubUrl("production")).toBe(
      "https://www.vellum.ai/assistant",
    );
    expect(cloudWebHubUrl("staging")).toBe(
      "https://staging-assistant.vellum.ai/assistant",
    );
    expect(cloudWebHubUrl("dev")).toBe(
      "https://dev-assistant.vellum.ai/assistant",
    );
    expect(cloudWebHubUrl("local")).toBe(
      "https://dev-assistant.vellum.ai/assistant",
    );
    expect(cloudWebHubUrl(undefined)).toBe(
      "https://dev-assistant.vellum.ai/assistant",
    );
  });
});

describe("nginx ingress process state", () => {
  function writeIngressState(workspaceDir: string, listenPort: number): void {
    writeFileSync(
      join(workspaceDir, "config.json"),
      JSON.stringify({ ingress: { nginx: { listenPort } } }) + "\n",
    );
  }

  function writePidFile(workspaceDir: string, pid: number): void {
    const dir = join(workspaceDir, "data", "ingress");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "nginx.pid"), `${pid}\n`);
  }

  function pidPath(workspaceDir: string): string {
    return join(workspaceDir, "data", "ingress", "nginx.pid");
  }

  function nginxCommand(workspaceDir: string): string {
    const dir = join(workspaceDir, "data", "ingress");
    return `nginx: master process nginx -p ${dir} -c ${join(dir, "nginx.conf")} -g daemon off;`;
  }

  test("clears ingress state after nginx is confirmed stopped", async () => {
    const ws = makeWorkspace();
    const pid = 123_456;
    let alive = true;
    writeIngressState(ws, 7841);
    writePidFile(ws, pid);
    execFileSyncMock.mockReturnValue(nginxCommand(ws));
    process.kill = mock((targetPid: number, signal?: string | number) => {
      if (targetPid !== pid) return originalKill(targetPid, signal);
      if (signal === 0) {
        if (!alive) throw new Error("dead");
        return true;
      }
      if (signal === "SIGTERM") {
        alive = false;
        return true;
      }
      return true;
    }) as unknown as typeof process.kill;

    await expect(stopIngressNginx(ws)).resolves.toBe(true);

    const config = readConfig(ws);
    expect((config.ingress as Record<string, unknown>).nginx).toBeUndefined();
    expect(existsSync(pidPath(ws))).toBe(false);
  });

  test("keeps ingress state when nginx kill fails", async () => {
    const ws = makeWorkspace();
    const pid = 123_457;
    writeIngressState(ws, 7841);
    writePidFile(ws, pid);
    execFileSyncMock.mockReturnValue(nginxCommand(ws));
    process.kill = mock((targetPid: number, signal?: string | number) => {
      if (targetPid !== pid) return originalKill(targetPid, signal);
      if (signal === 0) return true;
      throw new Error("operation not permitted");
    }) as unknown as typeof process.kill;

    await expect(stopIngressNginx(ws)).resolves.toBe(false);

    const config = readConfig(ws);
    expect((config.ingress as Record<string, unknown>).nginx).toEqual({
      listenPort: 7841,
    });
    expect(existsSync(pidPath(ws))).toBe(true);
  });

  test("clears ingress state when nginx exits before SIGTERM", async () => {
    const ws = makeWorkspace();
    const pid = 123_458;
    let aliveChecks = 0;
    writeIngressState(ws, 7841);
    writePidFile(ws, pid);
    execFileSyncMock.mockReturnValue(nginxCommand(ws));
    process.kill = mock((targetPid: number, signal?: string | number) => {
      if (targetPid !== pid) return originalKill(targetPid, signal);
      if (signal === 0) {
        aliveChecks++;
        if (aliveChecks === 1) return true;
        throw new Error("dead");
      }
      throw new Error("no such process");
    }) as unknown as typeof process.kill;

    await expect(stopIngressNginx(ws)).resolves.toBe(true);

    const config = readConfig(ws);
    expect((config.ingress as Record<string, unknown>).nginx).toBeUndefined();
    expect(existsSync(pidPath(ws))).toBe(false);
  });

  test("does not kill another nginx instance when clearing stale state", async () => {
    const ws = makeWorkspace();
    const pid = 123_459;
    writeIngressState(ws, 7841);
    writePidFile(ws, pid);
    execFileSyncMock.mockReturnValue(
      "nginx: master process nginx -p /tmp/other-ingress -c /tmp/other-ingress/nginx.conf",
    );
    process.kill = mock((targetPid: number, signal?: string | number) => {
      if (targetPid !== pid) return originalKill(targetPid, signal);
      if (signal === 0) return true;
      throw new Error("should not kill another nginx instance");
    }) as unknown as typeof process.kill;

    await expect(stopIngressNginx(ws)).resolves.toBe(false);

    const config = readConfig(ws);
    expect((config.ingress as Record<string, unknown>).nginx).toBeUndefined();
    expect(existsSync(pidPath(ws))).toBe(false);
  });
});

const NGINX_VERSION = "nginx version: nginx/1.29.0";
const FAKE_INDEX_HTML = "<html><head></head><body></body></html>";
const WEB_INDEX_SUFFIX = join("dist", "index.html");

function ingressConfPath(workspaceDir: string): string {
  return join(workspaceDir, "data", "ingress", "nginx.conf");
}

function mockNginxInstalled(): void {
  spawnSyncMock.mockReturnValue({
    pid: 4242,
    output: [],
    stdout: "",
    stderr: NGINX_VERSION,
    status: 0,
    signal: null,
  });
}

function mockNginxMissing(): void {
  spawnSyncMock.mockReturnValue({
    pid: 0,
    output: [],
    stdout: "",
    stderr: "",
    status: 1,
    signal: null,
  });
}

const SPAWNED_NGINX_PID = 4243;

/**
 * Spawned nginx that wins its bind: alive as the master, and it records its
 * pid under the prefix dir like a real `daemon off` master, with a matching
 * ps answer so getIngressPid confirms ownership.
 */
function mockNginxSpawn(): void {
  spawnMock.mockImplementation(((_command: string, args: readonly string[]) => {
    const dir = String(args[args.indexOf("-p") + 1]);
    realFs.writeFileSync(join(dir, "nginx.pid"), `${SPAWNED_NGINX_PID}\n`);
    fakePids.set(SPAWNED_NGINX_PID, { alive: true });
    installKillMock();
    execFileSyncMock.mockImplementation(((
      _file: string,
      psArgs?: readonly string[],
    ) =>
      psArgs?.includes(String(SPAWNED_NGINX_PID))
        ? `nginx: master process nginx -p ${dir} -c ${join(dir, "nginx.conf")} -g daemon off;`
        : "") as typeof childProcess.execFileSync);
    return {
      unref: () => {},
      once: () => {},
      exitCode: null,
      pid: SPAWNED_NGINX_PID,
    } as unknown as ChildProcess;
  }) as unknown as typeof childProcess.spawn);
}

/** Spawned nginx that exits on startup, as when the listen port is already bound. */
function mockNginxSpawnExitsOnStartup(): void {
  spawnMock.mockReturnValue({
    unref: () => {},
    once: (event: string, listener: () => void) => {
      if (event === "exit") listener();
    },
    exitCode: 1,
    pid: SPAWNED_NGINX_PID,
  } as unknown as ChildProcess);
}

/**
 * Spawned nginx that loses the bind race to a healthy squatter: still alive
 * when the probe resolves, exits shortly after, never writes a pid file.
 */
function mockNginxSpawnExitsAfterProbe(): void {
  spawnMock.mockImplementation((() => {
    const child = {
      unref: () => {},
      exitCode: null as number | null,
      pid: SPAWNED_NGINX_PID,
      once: (event: string, listener: () => void) => {
        if (event === "exit") {
          setTimeout(() => {
            child.exitCode = 1;
            listener();
          }, 150);
        }
      },
    };
    return child as unknown as ChildProcess;
  }) as unknown as typeof childProcess.spawn);
}

/** Force findWebDistDir() to resolve nothing, regardless of checkout state. */
function mockWebDistMissing(): void {
  existsSyncMock.mockImplementation((path) =>
    String(path).endsWith("index.html") ? false : realFs.existsSync(path),
  );
}

/** Force findWebDistDir() to resolve a dist dir, regardless of checkout state. */
function mockWebDistPresent(): void {
  existsSyncMock.mockImplementation((path) =>
    String(path).endsWith(WEB_INDEX_SUFFIX) ? true : realFs.existsSync(path),
  );
  readFileSyncMock.mockImplementation(((path, options) =>
    String(path).endsWith(WEB_INDEX_SUFFIX)
      ? FAKE_INDEX_HTML
      : realFs.readFileSync(
          path as never,
          options as never,
        )) as typeof readFileSync);
}

/** Record a running edge: ingress state, live pidfile, matching ps output. */
function mockRunningEdge(
  ws: string,
  opts: {
    listenPort: number;
    includeWebApp?: boolean;
    gatewayPort?: number;
    remoteWebConfigHash?: string;
  },
): number {
  const pid = 123_460;
  writeFileSync(
    join(ws, "config.json"),
    JSON.stringify({
      ingress: {
        nginx: {
          listenPort: opts.listenPort,
          ...(opts.includeWebApp === undefined
            ? {}
            : { includeWebApp: opts.includeWebApp }),
          ...(opts.gatewayPort === undefined
            ? {}
            : { gatewayPort: opts.gatewayPort }),
          ...(opts.remoteWebConfigHash === undefined
            ? {}
            : { remoteWebConfigHash: opts.remoteWebConfigHash }),
        },
      },
    }) + "\n",
  );
  const dir = join(ws, "data", "ingress");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "nginx.pid"), `${pid}\n`);
  execFileSyncMock.mockReturnValue(
    `nginx: master process nginx -p ${dir} -c ${join(dir, "nginx.conf")} -g daemon off;`,
  );
  return pid;
}

/** SIGTERM to the given PID marks it dead; signal 0 reflects liveness. */
function mockKillableNginx(pid: number): { killed: () => boolean } {
  fakePids.set(pid, { alive: true });
  installKillMock();
  return { killed: () => fakePids.get(pid)?.alive === false };
}

/** The given PID stays alive: liveness probes succeed, kill signals fail. */
function mockUnkillableNginx(pid: number): void {
  fakePids.set(pid, { alive: true, unkillable: true });
  installKillMock();
}

const PRODUCTION_HUB_URL = "https://www.vellum.ai/assistant";

/**
 * Mirror of the SPA config fingerprint the edge records in its ingress state
 * (sha256 over the edge template version and the injected config JSON). Pins
 * both the injected config shape and the hash format; assumes the
 * production-pinned environment. `template` tracks `EDGE_TEMPLATE_VERSION`.
 */
function spaConfigHash(assistantName?: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        template: 2,
        config: {
          mode: "remote-gateway",
          apiBaseUrl: "/v1",
          platformDisabled: true,
          disablePlatform: true,
          ...(assistantName ? { assistantName } : {}),
          hubUrl: PRODUCTION_HUB_URL,
        },
      }),
    )
    .digest("hex");
}

const originalEnvironment = process.env.VELLUM_ENVIRONMENT;

/** Pin the build environment so the stamped hubUrl is deterministic. */
function pinProductionEnvironment(): void {
  beforeEach(() => {
    process.env.VELLUM_ENVIRONMENT = "production";
  });
  afterEach(() => {
    if (originalEnvironment === undefined) {
      delete process.env.VELLUM_ENVIRONMENT;
    } else {
      process.env.VELLUM_ENVIRONMENT = originalEnvironment;
    }
  });
}

describe("startRemoteWebIngress", () => {
  pinProductionEnvironment();

  test("webhooks-only mode starts the denylist+proxy edge without a web dist", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();

    const onStarting = mock(
      (_info: {
        version: string;
        webDistDir: string | null;
        listenPort: number;
      }) => {},
    );
    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      includeWebApp: false,
      onStarting,
    });

    expect(result).toEqual({
      status: "started",
      listenPort: 7845,
      webDistDir: null,
      version: NGINX_VERSION,
    });
    expect(onStarting).toHaveBeenCalledWith({
      version: NGINX_VERSION,
      webDistDir: null,
      listenPort: 7845,
    });

    const conf = realFs.readFileSync(ingressConfPath(ws), "utf-8");
    expect(conf).toBe(
      buildIngressNginxConfig({
        gatewayPort: 7830,
        listenPort: 7845,
        ipv6Loopback: hasIpv6Loopback(),
      }),
    );
    expect(conf).toContain("location = /auth/token { return 404; }");
    expect(conf).toContain("location = /v1/pair { return 404; }");
    expect(conf).toContain("proxy_pass http://127.0.0.1:7830;");
    expect(conf).not.toContain("__remote-index.html");
    expect(conf).not.toContain("location ^~ /assistant/assets/");
    expect(conf).not.toContain("alias ");
    expect((readConfig(ws).ingress as Record<string, unknown>).nginx).toEqual({
      listenPort: 7845,
      includeWebApp: false,
      gatewayPort: 7830,
    });
  });

  test("default mode serves the SPA config unchanged", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
    });

    if (result.status !== "started") {
      throw new Error(`expected started, got ${result.status}`);
    }
    const { webDistDir } = result;
    if (webDistDir === null) {
      throw new Error("expected a web dist dir in SPA mode");
    }

    const conf = realFs.readFileSync(ingressConfPath(ws), "utf-8");
    expect(conf).toBe(
      buildIngressNginxConfig({
        gatewayPort: 7830,
        listenPort: 7845,
        ipv6Loopback: hasIpv6Loopback(),
        remoteWebIngress: {
          webDistDir,
          indexHtmlPath: join(ws, "data", "ingress", "assistant-index.html"),
          hubUrl: PRODUCTION_HUB_URL,
        },
      }),
    );
    expect(conf).toContain("location ^~ /assistant/ {");
    expect(conf).toContain("location ^~ /webhooks/ {");
    const indexHtml = realFs.readFileSync(
      join(ws, "data", "ingress", "assistant-index.html"),
      "utf-8",
    );
    expect(indexHtml).toContain("remote-gateway");
    expect(indexHtml).toContain(`"hubUrl":"${PRODUCTION_HUB_URL}"`);
    // No assistant name was provided, so the served config omits the label.
    expect(indexHtml).not.toContain("assistantName");
    expect((readConfig(ws).ingress as Record<string, unknown>).nginx).toEqual({
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
      remoteWebConfigHash: spaConfigHash(),
    });
  });

  test("stamps the assistant label into the served config when provided", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      assistantName: "My Homelab",
    });

    expect(result.status).toBe("started");
    const indexHtml = realFs.readFileSync(
      join(ws, "data", "ingress", "assistant-index.html"),
      "utf-8",
    );
    expect(indexHtml).toContain('"assistantName":"My Homelab"');
    expect(indexHtml).toContain(`"hubUrl":"${PRODUCTION_HUB_URL}"`);
    const conf = realFs.readFileSync(ingressConfPath(ws), "utf-8");
    expect(conf).toContain('\\"assistantName\\":\\"My Homelab\\"');
  });

  test("default mode still requires the web dist", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();

    const onStarting = mock(() => {});
    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      onStarting,
    });

    expect(result).toEqual({ status: "web-dist-missing" });
    expect(onStarting).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(realFs.existsSync(ingressConfPath(ws))).toBe(false);
  });

  test("short-circuits when the running edge already serves the requested mode", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    const pid = mockRunningEdge(ws, {
      listenPort: 7845,
      includeWebApp: false,
      gatewayPort: 7830,
    });
    const edge = mockKillableNginx(pid);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      includeWebApp: false,
    });

    expect(result).toEqual({
      status: "already-running",
      listenPort: 7845,
      includeWebApp: false,
      gatewayPort: 7830,
    });
    expect(edge.killed()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("already-running carries the recorded listen port over the requested one", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    const pid = mockRunningEdge(ws, {
      listenPort: 7845,
      includeWebApp: false,
      gatewayPort: 7830,
    });
    const edge = mockKillableNginx(pid);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7999,
      includeWebApp: false,
    });

    expect(result).toEqual({
      status: "already-running",
      listenPort: 7845,
      includeWebApp: false,
      gatewayPort: 7830,
    });
    expect(edge.killed()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("a failed restart reports the recorded mode and gateway port", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    const pid = mockRunningEdge(ws, {
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7900,
    });
    mockUnkillableNginx(pid);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      includeWebApp: false,
    });

    expect(result).toEqual({
      status: "already-running",
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7900,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("restarts the edge when its recorded gateway port drifts from the request", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    const pid = mockRunningEdge(ws, {
      listenPort: 7845,
      includeWebApp: false,
      gatewayPort: 7900,
    });
    const edge = mockKillableNginx(pid);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      includeWebApp: false,
    });

    expect(result).toEqual({
      status: "started",
      listenPort: 7845,
      webDistDir: null,
      version: NGINX_VERSION,
    });
    expect(edge.killed()).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const conf = realFs.readFileSync(ingressConfPath(ws), "utf-8");
    expect(conf).toBe(
      buildIngressNginxConfig({
        gatewayPort: 7830,
        listenPort: 7845,
        ipv6Loopback: hasIpv6Loopback(),
      }),
    );
    expect(conf).toContain("proxy_pass http://127.0.0.1:7830;");
    expect((readConfig(ws).ingress as Record<string, unknown>).nginx).toEqual({
      listenPort: 7845,
      includeWebApp: false,
      gatewayPort: 7830,
    });
  });

  test("restarts an edge whose state predates the recorded gateway port", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    const pid = mockRunningEdge(ws, { listenPort: 7845, includeWebApp: false });
    const edge = mockKillableNginx(pid);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7900,
      listenPort: 7845,
      includeWebApp: false,
    });

    expect(result).toEqual({
      status: "started",
      listenPort: 7845,
      webDistDir: null,
      version: NGINX_VERSION,
    });
    expect(edge.killed()).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(realFs.readFileSync(ingressConfPath(ws), "utf-8")).toBe(
      buildIngressNginxConfig({
        gatewayPort: 7900,
        listenPort: 7845,
        ipv6Loopback: hasIpv6Loopback(),
      }),
    );
    expect((readConfig(ws).ingress as Record<string, unknown>).nginx).toEqual({
      listenPort: 7845,
      includeWebApp: false,
      gatewayPort: 7900,
    });
  });

  test("treats recorded state without a mode as an SPA edge", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    const pid = mockRunningEdge(ws, {
      listenPort: 7845,
      gatewayPort: 7830,
      remoteWebConfigHash: spaConfigHash(),
    });
    const edge = mockKillableNginx(pid);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
    });

    expect(result).toEqual({
      status: "already-running",
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
    });
    expect(edge.killed()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("short-circuits when the running SPA edge already serves the requested config", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge(ws, {
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
      remoteWebConfigHash: spaConfigHash("My Homelab"),
    });
    const edge = mockKillableNginx(pid);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      assistantName: "My Homelab",
    });

    expect(result).toEqual({
      status: "already-running",
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
    });
    expect(edge.killed()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("restarts the edge when the injected SPA config drifts from the recorded one", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge(ws, {
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
      remoteWebConfigHash: spaConfigHash("Old Name"),
    });
    const edge = mockKillableNginx(pid);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      assistantName: "New Name",
    });

    expect(result.status).toBe("started");
    expect(edge.killed()).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const indexHtml = realFs.readFileSync(
      join(ws, "data", "ingress", "assistant-index.html"),
      "utf-8",
    );
    expect(indexHtml).toContain('"assistantName":"New Name"');
    expect((readConfig(ws).ingress as Record<string, unknown>).nginx).toEqual({
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
      remoteWebConfigHash: spaConfigHash("New Name"),
    });
  });

  test("restarts an SPA edge recorded against an older template version", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    // Same injected config, earlier template: the detached edge serves an
    // index this build renders differently, so identity must not match.
    const priorTemplateHash = createHash("sha256")
      .update(
        JSON.stringify({
          template: 1,
          config: {
            mode: "remote-gateway",
            apiBaseUrl: "/v1",
            platformDisabled: true,
            disablePlatform: true,
            hubUrl: PRODUCTION_HUB_URL,
          },
        }),
      )
      .digest("hex");
    const pid = mockRunningEdge(ws, {
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
      remoteWebConfigHash: priorTemplateHash,
    });
    const edge = mockKillableNginx(pid);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
    });

    expect(result.status).toBe("started");
    expect(edge.killed()).toBe(true);
    expect((readConfig(ws).ingress as Record<string, unknown>).nginx).toEqual({
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
      remoteWebConfigHash: spaConfigHash(),
    });
  });

  test("restarts an SPA edge whose state predates the config fingerprint", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge(ws, {
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
    });
    const edge = mockKillableNginx(pid);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
    });

    expect(result.status).toBe("started");
    expect(edge.killed()).toBe(true);
    expect((readConfig(ws).ingress as Record<string, unknown>).nginx).toEqual({
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
      remoteWebConfigHash: spaConfigHash(),
    });
  });

  test("a config-drifted edge that survives the restart attempt reports it as stale", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge(ws, {
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
      remoteWebConfigHash: spaConfigHash("Old Name"),
    });
    mockUnkillableNginx(pid);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      assistantName: "New Name",
    });

    expect(result).toEqual({
      status: "already-running",
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
      staleRemoteWebConfig: true,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("restarts an SPA edge when webhooks-only mode is requested", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    const pid = mockRunningEdge(ws, { listenPort: 7845, includeWebApp: true });
    const edge = mockKillableNginx(pid);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      includeWebApp: false,
    });

    expect(result).toEqual({
      status: "started",
      listenPort: 7845,
      webDistDir: null,
      version: NGINX_VERSION,
    });
    expect(edge.killed()).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const conf = realFs.readFileSync(ingressConfPath(ws), "utf-8");
    expect(conf).toBe(
      buildIngressNginxConfig({
        gatewayPort: 7830,
        listenPort: 7845,
        ipv6Loopback: hasIpv6Loopback(),
      }),
    );
    expect((readConfig(ws).ingress as Record<string, unknown>).nginx).toEqual({
      listenPort: 7845,
      includeWebApp: false,
      gatewayPort: 7830,
    });
  });

  test("starts the requested mode when the old edge exits during the stop", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    const pid = mockRunningEdge(ws, { listenPort: 7845, includeWebApp: true });
    // Alive for the initial running check, dead by the time the stop helper
    // probes it: the race where the old edge exits on its own mid-switch.
    let liveChecks = 0;
    process.kill = mock((targetPid: number, signal?: string | number) => {
      if (targetPid !== pid) return originalKill(targetPid, signal);
      if (signal === 0 && ++liveChecks === 1) return true;
      throw new Error("dead");
    }) as unknown as typeof process.kill;

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      includeWebApp: false,
    });

    expect(result).toEqual({
      status: "started",
      listenPort: 7845,
      webDistDir: null,
      version: NGINX_VERSION,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const conf = realFs.readFileSync(ingressConfPath(ws), "utf-8");
    expect(conf).toBe(
      buildIngressNginxConfig({
        gatewayPort: 7830,
        listenPort: 7845,
        ipv6Loopback: hasIpv6Loopback(),
      }),
    );
    expect((readConfig(ws).ingress as Record<string, unknown>).nginx).toEqual({
      listenPort: 7845,
      includeWebApp: false,
      gatewayPort: 7830,
    });
  });

  test("restarts a webhooks-only edge when SPA mode is requested", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge(ws, { listenPort: 7845, includeWebApp: false });
    const edge = mockKillableNginx(pid);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
    });

    if (result.status !== "started") {
      throw new Error(`expected started, got ${result.status}`);
    }
    expect(result.webDistDir).not.toBeNull();
    expect(edge.killed()).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const conf = realFs.readFileSync(ingressConfPath(ws), "utf-8");
    expect(conf).toContain("location ^~ /assistant/ {");
    expect((readConfig(ws).ingress as Record<string, unknown>).nginx).toEqual({
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
      remoteWebConfigHash: spaConfigHash(),
    });
  });

  test("keeps a webhooks-only edge running when SPA mode is requested without a web dist", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    const pid = mockRunningEdge(ws, { listenPort: 7845, includeWebApp: false });
    const edge = mockKillableNginx(pid);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
    });

    expect(result).toEqual({ status: "web-dist-missing" });
    expect(edge.killed()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
    expect((readConfig(ws).ingress as Record<string, unknown>).nginx).toEqual({
      listenPort: 7845,
      includeWebApp: false,
    });
  });

  test("a spawn that exits despite a successful probe is a port conflict, not started", async () => {
    // Another assistant's edge on the same listen port answers the readiness
    // probe while this workspace's nginx dies on the bind, so a healthy probe
    // alone must not count as started.
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawnExitsOnStartup();
    mockWebDistMissing();
    waitForDaemonReadyMock.mockImplementation(async () => true);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      includeWebApp: false,
    });

    expect(result).toEqual({
      status: "port-conflict",
      listenPort: 7845,
      logPath: join(ws, "data", "logs", "nginx-ingress.log"),
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const ingress = readConfig(ws).ingress as
      | Record<string, unknown>
      | undefined;
    expect(ingress?.nginx).toBeUndefined();
  });

  test("a child that outlives the probe but never owns the port is a port conflict", async () => {
    // The healthy-squatter race: another workspace's edge answers the probe in
    // milliseconds, while our master is still failing its bind. The child being
    // alive right after the probe must not count as started.
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawnExitsAfterProbe();
    mockWebDistMissing();
    waitForDaemonReadyMock.mockImplementation(async () => true);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      includeWebApp: false,
    });

    expect(result).toEqual({
      status: "port-conflict",
      listenPort: 7845,
      logPath: join(ws, "data", "logs", "nginx-ingress.log"),
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const ingress = readConfig(ws).ingress as
      | Record<string, unknown>
      | undefined;
    expect(ingress?.nginx).toBeUndefined();
  });

  test("started requires the pid file to name the live spawned master", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      includeWebApp: false,
    });

    expect(result).toEqual({
      status: "started",
      listenPort: 7845,
      webDistDir: null,
      version: NGINX_VERSION,
    });
    expect(
      realFs
        .readFileSync(join(ws, "data", "ingress", "nginx.pid"), "utf-8")
        .trim(),
    ).toBe(String(SPAWNED_NGINX_PID));
    // Ownership confirmed on the first settle iteration: exactly one ps
    // lookup, for the spawned master's pid, with no polling delay.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0]?.[1]).toContain(
      String(SPAWNED_NGINX_PID),
    );
  });

  test("a spawn that exits with a failed probe is also a port conflict", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawnExitsOnStartup();
    mockWebDistMissing();
    waitForDaemonReadyMock.mockImplementation(async () => false);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      includeWebApp: false,
    });

    expect(result.status).toBe("port-conflict");
  });

  test("a child still retrying its bind at the settle deadline is killed before rollback", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockWebDistMissing();
    const kills: string[] = [];
    // Alive for the whole settle window (nginx retrying its bind), never
    // writes a pid file; an orphan left running could win the bind later.
    spawnMock.mockImplementation((() => {
      return {
        unref: () => {},
        exitCode: null,
        pid: SPAWNED_NGINX_PID,
        once: () => {},
        kill: (signal: string) => {
          kills.push(signal);
          return true;
        },
      } as unknown as ChildProcess;
    }) as unknown as typeof childProcess.spawn);

    const result = await startRemoteWebIngress({
      workspaceDir: ws,
      gatewayPort: 7830,
      listenPort: 7845,
      includeWebApp: false,
    });

    expect(result.status).toBe("port-conflict");
    expect(kills).toEqual(["SIGTERM"]);
  }, 10_000);
});

describe("ensureTunnelEdge", () => {
  const ASSISTANT_ID = "assistant-1";
  const REQUESTED_PORT = 7846;
  const originalIngressPort = process.env.VELLUM_NGINX_INGRESS_PORT;
  const originalLockfileDir = process.env.VELLUM_LOCKFILE_DIR;
  let lockfileDir: string;

  pinProductionEnvironment();

  beforeEach(() => {
    process.env.VELLUM_NGINX_INGRESS_PORT = String(REQUESTED_PORT);
    // Isolated lockfile dir so the assistant-name lookup never reads a real
    // machine lockfile.
    lockfileDir = makeWorkspace();
    process.env.VELLUM_LOCKFILE_DIR = lockfileDir;
  });

  afterEach(() => {
    if (originalIngressPort === undefined) {
      delete process.env.VELLUM_NGINX_INGRESS_PORT;
    } else {
      process.env.VELLUM_NGINX_INGRESS_PORT = originalIngressPort;
    }
    if (originalLockfileDir === undefined) {
      delete process.env.VELLUM_LOCKFILE_DIR;
    } else {
      process.env.VELLUM_LOCKFILE_DIR = originalLockfileDir;
    }
  });

  test("threads the lockfile display name into the served SPA config", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    writeFileSync(
      join(lockfileDir, ".vellum.lock.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: ASSISTANT_ID,
            name: "Homelab",
            cloud: "local",
            runtimeUrl: "http://127.0.0.1:7830",
            localUrl: "http://127.0.0.1:7830",
          },
        ],
        activeAssistant: ASSISTANT_ID,
      }),
    );

    const result = await ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    expect(result.includesWebApp).toBe(true);
    const indexHtml = realFs.readFileSync(
      join(ws, "data", "ingress", "assistant-index.html"),
      "utf-8",
    );
    expect(indexHtml).toContain('"assistantName":"Homelab"');
    expect(indexHtml).toContain(`"hubUrl":"${PRODUCTION_HUB_URL}"`);
  });

  test("omits the assistant label when the lockfile has no matching entry", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();

    const result = await ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    expect(result.includesWebApp).toBe(true);
    const indexHtml = realFs.readFileSync(
      join(ws, "data", "ingress", "assistant-index.html"),
      "utf-8",
    );
    expect(indexHtml).not.toContain("assistantName");
    expect(indexHtml).toContain(`"hubUrl":"${PRODUCTION_HUB_URL}"`);
  });

  test("reuses a running edge that matches the flag-resolved mode", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    const pid = mockRunningEdge(ws, {
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
      remoteWebConfigHash: spaConfigHash(),
    });
    const edge = mockKillableNginx(pid);

    const result = await ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    expect(result).toEqual({
      port: 7845,
      started: false,
      includesWebApp: true,
    });
    expect(edge.killed()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("reuses a running webhooks-only edge and reports the recorded mode", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    isFeatureFlagEnabledMock.mockImplementation(async () => false);
    const pid = mockRunningEdge(ws, {
      listenPort: 7845,
      includeWebApp: false,
      gatewayPort: 7830,
    });
    const edge = mockKillableNginx(pid);

    const result = await ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    expect(result).toEqual({
      port: 7845,
      started: false,
      includesWebApp: false,
    });
    expect(edge.killed()).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("restarts the edge when the lockfile display name changes", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const writeLockfile = (name: string) =>
      writeFileSync(
        join(lockfileDir, ".vellum.lock.json"),
        JSON.stringify({
          assistants: [
            {
              assistantId: ASSISTANT_ID,
              name,
              cloud: "local",
              runtimeUrl: "http://127.0.0.1:7830",
              localUrl: "http://127.0.0.1:7830",
            },
          ],
          activeAssistant: ASSISTANT_ID,
        }),
      );
    writeLockfile("Homelab");

    const first = await ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });
    expect(first.started).toBe(true);

    // Same port and mode, renamed assistant: the edge must restart so the
    // served index carries the new label instead of reporting already-running.
    writeLockfile("Renamed");
    const second = await ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    expect(second.started).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const indexHtml = realFs.readFileSync(
      join(ws, "data", "ingress", "assistant-index.html"),
      "utf-8",
    );
    expect(indexHtml).toContain('"assistantName":"Renamed"');
    expect(indexHtml).not.toContain('"assistantName":"Homelab"');
  });

  test("a config-drifted edge that survives the restart attempt throws", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();
    const pid = mockRunningEdge(ws, {
      listenPort: REQUESTED_PORT,
      includeWebApp: true,
      gatewayPort: 7830,
      remoteWebConfigHash: spaConfigHash("Stale Name"),
    });
    mockUnkillableNginx(pid);

    const promise = ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    await expect(promise).rejects.toThrow(
      "still serving an outdated remote web config",
    );
    await expect(promise).rejects.toThrow("vellum nginx-ingress down");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("a mode-drifted edge that survives the restart attempt throws", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    isFeatureFlagEnabledMock.mockImplementation(async () => false);
    const pid = mockRunningEdge(ws, { listenPort: 7845, includeWebApp: true });
    mockUnkillableNginx(pid);

    const promise = ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    await expect(promise).rejects.toThrow(
      "still running in web app mode and could not be restarted in webhooks-only mode",
    );
    await expect(promise).rejects.toThrow("vellum nginx-ingress down");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("a port-drifted edge that survives the restart attempt throws", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    isFeatureFlagEnabledMock.mockImplementation(async () => false);
    const pid = mockRunningEdge(ws, {
      listenPort: 7845,
      includeWebApp: false,
      gatewayPort: 7900,
    });
    mockUnkillableNginx(pid);

    const promise = ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    await expect(promise).rejects.toThrow(
      "still proxying gateway port 7900 and could not be restarted against port 7830",
    );
    await expect(promise).rejects.toThrow("vellum nginx-ingress down");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("restarts a port-drifted edge against the requested gateway port", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    isFeatureFlagEnabledMock.mockImplementation(async () => false);
    const pid = mockRunningEdge(ws, {
      listenPort: 7845,
      includeWebApp: false,
      gatewayPort: 7900,
    });
    const edge = mockKillableNginx(pid);

    const result = await ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    expect(result).toEqual({
      port: REQUESTED_PORT,
      started: true,
      includesWebApp: false,
    });
    expect(edge.killed()).toBe(true);
    const conf = realFs.readFileSync(ingressConfPath(ws), "utf-8");
    expect(conf).toBe(
      buildIngressNginxConfig({
        gatewayPort: 7830,
        listenPort: REQUESTED_PORT,
        ipv6Loopback: hasIpv6Loopback(),
      }),
    );
  });

  test("restarts a mode-drifted edge into the flag-resolved mode", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    isFeatureFlagEnabledMock.mockImplementation(async () => false);
    const pid = mockRunningEdge(ws, { listenPort: 7845, includeWebApp: true });
    const edge = mockKillableNginx(pid);

    const result = await ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    expect(result).toEqual({
      port: REQUESTED_PORT,
      started: true,
      includesWebApp: false,
    });
    expect(edge.killed()).toBe(true);
    const conf = realFs.readFileSync(ingressConfPath(ws), "utf-8");
    expect(conf).toBe(
      buildIngressNginxConfig({
        gatewayPort: 7830,
        listenPort: REQUESTED_PORT,
        ipv6Loopback: hasIpv6Loopback(),
      }),
    );
  });

  test("flag enabled starts the SPA edge", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistPresent();

    const result = await ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    expect(result).toEqual({
      port: REQUESTED_PORT,
      started: true,
      includesWebApp: true,
    });
    expect(isFeatureFlagEnabledMock).toHaveBeenCalledWith(
      ASSISTANT_ID,
      featureFlags.WEB_REMOTE_INGRESS_FLAG,
      { runtimeUrl: "http://127.0.0.1:7830" },
    );
    const conf = realFs.readFileSync(ingressConfPath(ws), "utf-8");
    expect(conf).toContain("location ^~ /assistant/ {");
    expect(conf).toContain("location ^~ /webhooks/ {");
    expect((readConfig(ws).ingress as Record<string, unknown>).nginx).toEqual({
      listenPort: REQUESTED_PORT,
      includeWebApp: true,
      gatewayPort: 7830,
      remoteWebConfigHash: spaConfigHash(),
    });
  });

  test("flag disabled starts the webhooks-only edge", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    isFeatureFlagEnabledMock.mockImplementation(async () => false);

    const result = await ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    expect(result).toEqual({
      port: REQUESTED_PORT,
      started: true,
      includesWebApp: false,
    });
    const conf = realFs.readFileSync(ingressConfPath(ws), "utf-8");
    expect(conf).toContain("location = /v1/pair { return 404; }");
    expect(conf).not.toContain("location ^~ /assistant/ {");
    expect((readConfig(ws).ingress as Record<string, unknown>).nginx).toEqual({
      listenPort: REQUESTED_PORT,
      includeWebApp: false,
      gatewayPort: 7830,
    });
  });

  test("forwards onStarting so callers can print progress", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    isFeatureFlagEnabledMock.mockImplementation(async () => false);
    const onStarting = mock(
      (_info: {
        version: string;
        webDistDir: string | null;
        listenPort: number;
      }) => {},
    );

    await ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
      onStarting,
    });

    expect(onStarting).toHaveBeenCalledWith({
      version: NGINX_VERSION,
      webDistDir: null,
      listenPort: REQUESTED_PORT,
    });
  });

  test("an entry without an assistant id gets the webhooks-only edge", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();

    const result = await ensureTunnelEdge({
      assistantId: undefined,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    expect(result).toEqual({
      port: REQUESTED_PORT,
      started: true,
      includesWebApp: false,
    });
    expect(isFeatureFlagEnabledMock).not.toHaveBeenCalled();
    const conf = realFs.readFileSync(ingressConfPath(ws), "utf-8");
    expect(conf).not.toContain("location ^~ /assistant/ {");
  });

  test("missing nginx throws with install instructions", async () => {
    const ws = makeWorkspace();
    mockNginxMissing();

    const promise = ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    await expect(promise).rejects.toThrow("brew install nginx");
    await expect(promise).rejects.toThrow("apt install nginx");
    await expect(promise).rejects.toThrow("NGINX_BIN");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("flag lookup failure throws the wake hint", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    isFeatureFlagEnabledMock.mockImplementation(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const promise = ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    await expect(promise).rejects.toThrow(
      "Could not verify the `web-remote-ingress` feature flag",
    );
    await expect(promise).rejects.toThrow("Try `vellum wake` and retry");
    await expect(promise).rejects.toThrow("connect ECONNREFUSED");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("flagRetry retries a thrown flag lookup and then starts the edge", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    isFeatureFlagEnabledMock
      .mockImplementationOnce(async () => {
        throw new Error('HTTP 503 {"status":"starting"}');
      })
      .mockImplementationOnce(async () => {
        throw new Error('HTTP 503 {"status":"starting"}');
      })
      .mockImplementationOnce(async () => false);

    const result = await ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
      flagRetry: { attempts: 3, intervalMs: 1 },
    });

    expect(isFeatureFlagEnabledMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      port: REQUESTED_PORT,
      started: true,
      includesWebApp: false,
    });
  });

  test("flagRetry does not retry a resolved false: it is a real answer", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    isFeatureFlagEnabledMock.mockImplementation(async () => false);

    const result = await ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
      flagRetry: { attempts: 3, intervalMs: 1 },
    });

    expect(isFeatureFlagEnabledMock).toHaveBeenCalledTimes(1);
    expect(result.includesWebApp).toBe(false);
  });

  test("an exhausted flagRetry throws the wake hint with the last error", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    isFeatureFlagEnabledMock.mockImplementation(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const promise = ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
      flagRetry: { attempts: 3, intervalMs: 1 },
    });

    await expect(promise).rejects.toThrow(
      "Could not verify the `web-remote-ingress` feature flag",
    );
    await expect(promise).rejects.toThrow("connect ECONNREFUSED");
    expect(isFeatureFlagEnabledMock).toHaveBeenCalledTimes(3);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("missing web dist with the flag enabled throws build guidance", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockWebDistMissing();

    await expect(
      ensureTunnelEdge({
        assistantId: ASSISTANT_ID,
        workspaceDir: ws,
        gatewayPort: 7830,
      }),
    ).rejects.toThrow("@vellumai/web");
  });

  test("an unreachable edge throws with the log path", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawn();
    mockWebDistMissing();
    isFeatureFlagEnabledMock.mockImplementation(async () => false);
    waitForDaemonReadyMock.mockImplementation(async () => false);

    await expect(
      ensureTunnelEdge({
        assistantId: ASSISTANT_ID,
        workspaceDir: ws,
        gatewayPort: 7830,
      }),
    ).rejects.toThrow(join(ws, "data", "logs", "nginx-ingress.log"));
  });

  test("a port conflict throws naming the port and the override mechanism", async () => {
    const ws = makeWorkspace();
    mockNginxInstalled();
    mockNginxSpawnExitsOnStartup();
    mockWebDistMissing();
    isFeatureFlagEnabledMock.mockImplementation(async () => false);
    waitForDaemonReadyMock.mockImplementation(async () => true);

    const promise = ensureTunnelEdge({
      assistantId: ASSISTANT_ID,
      workspaceDir: ws,
      gatewayPort: 7830,
    });

    await expect(promise).rejects.toThrow(
      `already in use (for example by another assistant's tunnel edge)`,
    );
    await expect(promise).rejects.toThrow(`127.0.0.1:${REQUESTED_PORT}`);
    await expect(promise).rejects.toThrow("VELLUM_NGINX_INGRESS_PORT");
    await expect(promise).rejects.toThrow(
      join(ws, "data", "logs", "nginx-ingress.log"),
    );
  });
});
