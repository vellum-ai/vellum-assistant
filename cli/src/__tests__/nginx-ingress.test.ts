import * as childProcess from "node:child_process";
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

import { afterEach, describe, expect, mock, test } from "bun:test";

const execFileSyncMock = mock(childProcess.execFileSync);

mock.module("node:child_process", () => ({
  ...childProcess,
  execFileSync: execFileSyncMock,
}));

import {
  buildIngressNginxConfig,
  buildRemoteWebIndexHtml,
  resolveTunnelTargetPort,
  stopIngressNginx,
} from "../lib/nginx-ingress.js";

const originalKill = process.kill;

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

  test("proxies requests to the gateway", () => {
    expect(conf).toContain("location / {");
    expect(conf).toContain("proxy_pass http://127.0.0.1:7830;");
    expect(conf).toContain('proxy_set_header X-Vellum-Edge-Forwarded "1";');
    expect(conf).not.toContain("return 404;");
    expect(conf).not.toContain("return 403;");
    expect(conf).not.toContain("location =");
    expect(conf).not.toContain("location ~");
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
  const workspaces: string[] = [];

  afterEach(() => {
    process.kill = originalKill;
    execFileSyncMock.mockReset();
    for (const dir of workspaces.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "vellum-ingress-test-"));
    workspaces.push(dir);
    return dir;
  }

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
