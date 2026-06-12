import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
} from "../lib/nginx-ingress.js";

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

describe("resolveTunnelTargetPort", () => {
  const workspaces: string[] = [];

  afterEach(() => {
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

  test("targets the ingress when state exists and the PID is nginx", () => {
    const ws = makeWorkspace();
    writeIngressState(ws, 7841);
    writePidFile(ws, process.pid);
    execFileSyncMock.mockReturnValue("nginx: master process nginx");
    expect(resolveTunnelTargetPort(ws, 7830)).toEqual({
      port: 7841,
      viaIngress: true,
    });
  });

  test("falls back when nginx ingress is not preferred", () => {
    const ws = makeWorkspace();
    writeIngressState(ws, 7841);
    writePidFile(ws, process.pid);
    execFileSyncMock.mockReturnValue("nginx: master process nginx");
    expect(
      resolveTunnelTargetPort(ws, 7830, { preferNginxIngress: false }),
    ).toEqual({
      port: 7830,
      viaIngress: false,
    });
  });
});
