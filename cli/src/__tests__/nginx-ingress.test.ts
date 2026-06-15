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
  resolveTunnelTargetPort,
  stopIngressNginx,
} from "../lib/nginx-ingress.js";

const originalKill = process.kill;

describe("buildIngressNginxConfig", () => {
  const conf = buildIngressNginxConfig({ gatewayPort: 7830, listenPort: 7840 });

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
    expect(conf).not.toContain("return 404;");
    expect(conf).not.toContain("return 403;");
    expect(conf).not.toContain("location =");
    expect(conf).not.toContain("location ~");
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
