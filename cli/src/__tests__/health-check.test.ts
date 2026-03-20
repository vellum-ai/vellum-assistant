import { describe, test, expect } from "bun:test";
import { checkHealth, HEALTH_CHECK_TIMEOUT_MS } from "../lib/health-check.js";

describe("checkHealth", () => {
  test("HEALTH_CHECK_TIMEOUT_MS is a positive number", () => {
    expect(typeof HEALTH_CHECK_TIMEOUT_MS).toBe("number");
    expect(HEALTH_CHECK_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("returns unreachable for non-existent host", async () => {
    const result = await checkHealth("http://127.0.0.1:1");
    expect(["unreachable", "timeout"]).toContain(result.status);
    expect(result.version).toBeUndefined();
  });

  test("returns healthy for a mock healthy endpoint", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ status: "healthy" });
      },
    });

    try {
      const result = await checkHealth(`http://localhost:${server.port}`);
      expect(result.status).toBe("healthy");
      expect(result.detail).toBeNull();
      expect(result.version).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("returns version when present in response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ status: "healthy", version: "1.2.3" });
      },
    });

    try {
      const result = await checkHealth(`http://localhost:${server.port}`);
      expect(result.status).toBe("healthy");
      expect(result.version).toBe("1.2.3");
    } finally {
      server.stop(true);
    }
  });

  test("returns status with detail for non-healthy response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          status: "degraded",
          message: "high latency",
          version: "0.9.0",
        });
      },
    });

    try {
      const result = await checkHealth(`http://localhost:${server.port}`);
      expect(result.status).toBe("degraded");
      expect(result.detail).toBe("high latency");
      expect(result.version).toBe("0.9.0");
    } finally {
      server.stop(true);
    }
  });

  test("returns error status for non-ok HTTP response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Internal Server Error", { status: 500 });
      },
    });

    try {
      const result = await checkHealth(`http://localhost:${server.port}`);
      expect(result.status).toBe("error (500)");
      expect(result.version).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});
