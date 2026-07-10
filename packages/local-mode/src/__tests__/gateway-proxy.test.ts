import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readAllowedGatewayPorts,
  resolveGatewayProxyTarget,
} from "../gateway-proxy";

const allow =
  (...ports: number[]) =>
  () =>
    new Set<number>(ports);

describe("resolveGatewayProxyTarget", () => {
  test("passes non-gateway pathnames through untouched", () => {
    expect(resolveGatewayProxyTarget("/index.html", allow(8080))).toEqual({
      kind: "pass",
    });
    expect(resolveGatewayProxyTarget("/assistant/assets/app.js", allow())).toEqual({
      kind: "pass",
    });
  });

  test("forwards an allowlisted port to its loopback target", () => {
    expect(
      resolveGatewayProxyTarget("/__gateway/8080/v1/assistants", allow(8080)),
    ).toEqual({
      kind: "forward",
      target: { port: 8080, path: "/v1/assistants" },
    });
  });

  test("accepts the renderer's `/assistant` mount prefix", () => {
    expect(
      resolveGatewayProxyTarget("/assistant/__gateway/8080/auth/token", allow(8080)),
    ).toEqual({
      kind: "forward",
      target: { port: 8080, path: "/auth/token" },
    });
  });

  test("defaults a portless tail to the gateway root", () => {
    expect(resolveGatewayProxyTarget("/__gateway/8080", allow(8080))).toEqual({
      kind: "forward",
      target: { port: 8080, path: "/" },
    });
  });

  test("rejects ports outside the 1024–65535 range as invalid", () => {
    expect(resolveGatewayProxyTarget("/__gateway/80/v1", allow(80))).toEqual({
      kind: "invalid-port",
    });
    expect(resolveGatewayProxyTarget("/__gateway/70000/v1", allow(70000))).toEqual({
      kind: "invalid-port",
    });
  });

  test("forbids a well-formed port that isn't registered in the lockfile", () => {
    expect(
      resolveGatewayProxyTarget("/__gateway/9999/v1", allow(8080)),
    ).toEqual({ kind: "forbidden-port", port: 9999 });
  });

  test("forbids every gateway port when the allowlist is empty", () => {
    expect(resolveGatewayProxyTarget("/__gateway/8080/v1", allow())).toEqual({
      kind: "forbidden-port",
      port: 8080,
    });
  });

  test("allowlists ports from resources, loopback URLs, and docker runtimeUrls — never remote URLs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-proxy-test-"));
    const lockfilePath = path.join(dir, "assistants.json");
    try {
      fs.writeFileSync(
        lockfilePath,
        JSON.stringify({
          assistants: [
            { assistantId: "local-a", resources: { gatewayPort: 7830 } },
            { assistantId: "local-b", localUrl: "http://127.0.0.1:7831" },
            // Docker entries record their published gateway only as a
            // loopback runtimeUrl.
            {
              assistantId: "docker-a",
              cloud: "docker",
              runtimeUrl: "http://localhost:7930",
            },
            // Remote runtimeUrls (managed / gcp / paired) must never widen
            // the allowlist.
            {
              assistantId: "remote-a",
              cloud: "gcp",
              runtimeUrl: "https://assistant.example.com:8443",
            },
          ],
        }),
      );
      expect(readAllowedGatewayPorts([lockfilePath])).toEqual(
        new Set([7830, 7831, 7930]),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never reads the allowlist for non-gateway or invalid-port paths", () => {
    let reads = 0;
    const counting = () => {
      reads += 1;
      return new Set<number>([8080]);
    };
    resolveGatewayProxyTarget("/index.html", counting);
    resolveGatewayProxyTarget("/__gateway/80/v1", counting);
    expect(reads).toBe(0);
    resolveGatewayProxyTarget("/__gateway/8080/v1", counting);
    expect(reads).toBe(1);
  });
});
