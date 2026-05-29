import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { waitForCloudflareTunnelUrl } from "../lib/cloudflare-tunnel.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal fake ChildProcess whose stdout and stderr are plain
 * EventEmitters. Tests control what data is emitted and when.
 */
function makeChild(): {
  child: ChildProcess;
  stdout: EventEmitter;
  stderr: EventEmitter;
  emitExit: (code: number | null) => void;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const childEmitter = new EventEmitter();

  const child = Object.assign(childEmitter, {
    stdout,
    stderr,
    killed: false,
    kill: () => false,
    pid: 99999,
  }) as unknown as ChildProcess;

  const emitExit = (code: number | null) => childEmitter.emit("exit", code);

  return { child, stdout, stderr, emitExit };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("waitForCloudflareTunnelUrl", () => {
  test("resolves when the URL appears on stderr", async () => {
    const { child, stderr } = makeChild();
    const promise = waitForCloudflareTunnelUrl(child);

    stderr.emit(
      "data",
      Buffer.from(
        "2024-01-01T00:00:00Z INF |  https://quick-slug-test.trycloudflare.com  |\n",
      ),
    );

    await expect(promise).resolves.toBe(
      "https://quick-slug-test.trycloudflare.com",
    );
  });

  test("resolves when the URL appears on stdout", async () => {
    const { child, stdout } = makeChild();
    const promise = waitForCloudflareTunnelUrl(child);

    stdout.emit(
      "data",
      Buffer.from("https://another-slug.trycloudflare.com\n"),
    );

    await expect(promise).resolves.toBe(
      "https://another-slug.trycloudflare.com",
    );
  });

  test("resolves with the first URL when multiple lines contain one", async () => {
    const { child, stderr } = makeChild();
    const promise = waitForCloudflareTunnelUrl(child);

    stderr.emit(
      "data",
      Buffer.from(
        "INFO https://first-slug.trycloudflare.com\nINFO https://second-slug.trycloudflare.com\n",
      ),
    );

    await expect(promise).resolves.toBe("https://first-slug.trycloudflare.com");
  });

  test("handles a URL split across two data chunks", async () => {
    const { child, stderr } = makeChild();
    const promise = waitForCloudflareTunnelUrl(child);

    // First chunk ends mid-line before the URL
    stderr.emit("data", Buffer.from("INFO Visit: "));
    // Second chunk completes the line
    stderr.emit(
      "data",
      Buffer.from("https://chunked-slug.trycloudflare.com\n"),
    );

    await expect(promise).resolves.toBe(
      "https://chunked-slug.trycloudflare.com",
    );
  });

  test("rejects when the process exits before a URL is found", async () => {
    const { child, emitExit } = makeChild();
    const promise = waitForCloudflareTunnelUrl(child);

    emitExit(1);

    await expect(promise).rejects.toThrow("exited with code 1");
  });

  test("rejects on null exit code (killed by signal)", async () => {
    const { child, emitExit } = makeChild();
    const promise = waitForCloudflareTunnelUrl(child);

    emitExit(null);

    await expect(promise).rejects.toThrow("exited with code unknown");
  });

  test("rejects after the timeout when no URL appears", async () => {
    const { child } = makeChild();
    // Use a very short timeout so the test runs fast
    const promise = waitForCloudflareTunnelUrl(child, 50);

    await expect(promise).rejects.toThrow("did not appear within");
  });

  test("does not resolve for non-trycloudflare.com hostnames", async () => {
    const { child, stderr, emitExit } = makeChild();
    const promise = waitForCloudflareTunnelUrl(child, 50);

    // Emit a line with a URL that is not a Cloudflare quick-tunnel URL
    stderr.emit("data", Buffer.from("Connecting to https://example.com/api\n"));

    // Should still time out — the fake URL does not match the pattern
    emitExit(null);
    await expect(promise).rejects.toThrow();
  });
});
