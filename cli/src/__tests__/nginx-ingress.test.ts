import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
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

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

import * as httpClient from "../lib/http-client.js";

const realChildProcess = { ...childProcess };
const realFs = { ...fsModule };
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

// Restore the real modules once this file finishes so the mocks do not leak
// into sibling test files in the same `bun test` run.
afterAll(() => {
  mock.module("node:child_process", () => realChildProcess);
  mock.module("node:fs", () => realFs);
  mock.module("../lib/http-client.js", () => realHttpClient);
});

import {
  buildIngressNginxConfig,
  buildRemoteWebIndexHtml,
  resolveTunnelTargetPort,
  startRemoteWebIngress,
  stopIngressNginx,
} from "../lib/nginx-ingress.js";

const originalKill = process.kill;
const workspaces: string[] = [];

afterEach(() => {
  process.kill = originalKill;
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
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "vellum-ingress-test-"));
  workspaces.push(dir);
  return dir;
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
      expect(directive).toContain("127.0.0.1");
    }
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

  function readConfig(workspaceDir: string): Record<string, unknown> {
    return JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    ) as Record<string, unknown>;
  }

  function pidPath(workspaceDir: string): string {
    return join(workspaceDir, "data", "ingress", "nginx.pid");
  }

  function nginxCommand(workspaceDir: string): string {
    const dir = join(workspaceDir, "data", "ingress");
    return `nginx: master process nginx -p ${dir} -c ${join(dir, "nginx.conf")} -g daemon off;`;
  }

  /** A PID guaranteed dead: a short-lived child that has already exited. */
  function deadPid(): number {
    const result = childProcess.spawnSync("sh", ["-c", "exit 0"]);
    if (!result.pid) throw new Error("failed to spawn probe process");
    return result.pid;
  }

  test("falls back to the gateway port when no ingress state exists", () => {
    const ws = makeWorkspace();
    expect(resolveTunnelTargetPort(ws, 7830)).toEqual({
      port: 7830,
      viaIngress: false,
    });
  });

  test("falls back when ingress state exists but the process is dead", () => {
    const ws = makeWorkspace();
    writeIngressState(ws, 7841);
    writePidFile(ws, deadPid());
    expect(resolveTunnelTargetPort(ws, 7830)).toEqual({
      port: 7830,
      viaIngress: false,
    });
  });

  test("falls back when the recorded PID belongs to a non-nginx process", () => {
    const ws = makeWorkspace();
    writeIngressState(ws, 7841);
    writePidFile(ws, process.pid);
    execFileSyncMock.mockReturnValue("bun test");
    expect(resolveTunnelTargetPort(ws, 7830)).toEqual({
      port: 7830,
      viaIngress: false,
    });
  });

  test("falls back when the recorded PID belongs to another nginx instance", () => {
    const ws = makeWorkspace();
    writeIngressState(ws, 7841);
    writePidFile(ws, process.pid);
    execFileSyncMock.mockReturnValue(
      "nginx: master process nginx -p /tmp/other-ingress -c /tmp/other-ingress/nginx.conf",
    );
    expect(resolveTunnelTargetPort(ws, 7830)).toEqual({
      port: 7830,
      viaIngress: false,
    });
  });

  test("targets the ingress when state exists and the PID is this nginx", () => {
    const ws = makeWorkspace();
    writeIngressState(ws, 7841);
    writePidFile(ws, process.pid);
    execFileSyncMock.mockReturnValue(nginxCommand(ws));
    expect(resolveTunnelTargetPort(ws, 7830)).toEqual({
      port: 7841,
      viaIngress: true,
    });
  });

  test("falls back when nginx ingress is not preferred", () => {
    const ws = makeWorkspace();
    writeIngressState(ws, 7841);
    writePidFile(ws, process.pid);
    execFileSyncMock.mockReturnValue(nginxCommand(ws));
    expect(
      resolveTunnelTargetPort(ws, 7830, { preferNginxIngress: false }),
    ).toEqual({
      port: 7830,
      viaIngress: false,
    });
  });

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

describe("startRemoteWebIngress", () => {
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

  function mockNginxSpawn(): void {
    spawnMock.mockReturnValue({
      unref: () => {},
      pid: 4243,
    } as unknown as ChildProcess);
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
      buildIngressNginxConfig({ gatewayPort: 7830, listenPort: 7845 }),
    );
    expect(conf).toContain("location = /auth/token { return 404; }");
    expect(conf).toContain("location = /v1/pair { return 404; }");
    expect(conf).toContain("proxy_pass http://127.0.0.1:7830;");
    expect(conf).not.toContain("__remote-index.html");
    expect(conf).not.toContain("location ^~ /assistant/assets/");
    expect(conf).not.toContain("alias ");
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
        remoteWebIngress: {
          webDistDir,
          indexHtmlPath: join(ws, "data", "ingress", "assistant-index.html"),
        },
      }),
    );
    expect(conf).toContain("location ^~ /assistant/ {");
    expect(conf).toContain("location ^~ /webhooks/ {");
    expect(
      realFs.readFileSync(
        join(ws, "data", "ingress", "assistant-index.html"),
        "utf-8",
      ),
    ).toContain("remote-gateway");
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
});
