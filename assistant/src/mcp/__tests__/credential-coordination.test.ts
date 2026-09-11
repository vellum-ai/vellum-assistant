import { describe, expect, test } from "bun:test";

import {
  createMcpCredentialFence,
  withMcpCredentialLock,
} from "../credential-coordination.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function child(code: string) {
  const moduleUrl = new URL("../credential-coordination.ts", import.meta.url)
    .href;
  return Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { createMcpCredentialFence, withMcpCredentialLock } from ${JSON.stringify(
      moduleUrl,
    )};
    ${code}
  `,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
      windowsHide: true,
    },
  );
}

async function readLine(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunk = await reader.read();
  if (chunk.done) {
    throw new Error("Child exited before signalling readiness");
  }
  return new TextDecoder().decode(chunk.value).trim();
}

describe("MCP credential coordination", () => {
  test("a live writer is never stolen even when the acquisition deadline expires", async () => {
    const worker =
      child(`await withMcpCredentialLock("live-owner", async () => {
      console.log("LOCKED"); await Bun.stdin.text();
    });`);
    try {
      const output = worker.stdout.getReader();
      expect(await readLine(output)).toBe("LOCKED");
      await expect(
        withMcpCredentialLock("live-owner", async () => {}, 0),
      ).rejects.toThrow("storage is busy");
      worker.stdin.end();
      expect(await worker.exited).toBe(0);
      await withMcpCredentialLock("live-owner", async () => {});
    } finally {
      worker.kill();
    }
  });

  test("a dead owner's lock is reclaimed without stealing another live owner's lease", async () => {
    const worker =
      child(`await withMcpCredentialLock("crashed-owner", async () => {
      console.log("LOCKED"); await Bun.stdin.text();
    });`);
    try {
      expect(await readLine(worker.stdout.getReader())).toBe("LOCKED");
      worker.kill("SIGKILL");
      await worker.exited;
      const entered = deferred();
      const release = deferred();
      const recovered = withMcpCredentialLock("crashed-owner", async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      await expect(
        withMcpCredentialLock("crashed-owner", async () => {}, 0),
      ).rejects.toThrow("storage is busy");
      release.resolve();
      await recovered;
    } finally {
      worker.kill();
    }
  });

  test("a worker refresh from a removed generation cannot write after teardown", async () => {
    const worker = child(`
      const fence = createMcpCredentialFence("worker-refresh");
      console.log("READY"); await Bun.stdin.text();
      try { await fence.write(async () => { console.log("WROTE"); }); }
      catch { console.log("STALE"); }
    `);
    try {
      const output = worker.stdout.getReader();
      expect(await readLine(output)).toBe("READY");
      await withMcpCredentialLock("worker-refresh", async (lease) => {
        lease.advance();
      });
      worker.stdin.end();
      expect(await readLine(output)).toBe("STALE");
      expect(await worker.exited).toBe(0);
    } finally {
      worker.kill();
    }
  });

  test("closing a provider fences writes queued behind an earlier writer", async () => {
    const fence = createMcpCredentialFence("queued-write");
    const entered = deferred();
    const release = deferred();
    const first = fence.write(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const queued = fence.write(async () => {
      throw new Error("must not execute");
    });
    fence.close();
    release.resolve();
    await first;
    await expect(queued).rejects.toThrow("connection changed");
  });

  test("closure during asynchronous ownership validation prevents persistence", async () => {
    const entered = deferred();
    const release = deferred();
    const fence = createMcpCredentialFence("validation-race", async () => {
      entered.resolve();
      await release.promise;
      return true;
    });
    const write = fence.write(async () => {
      throw new Error("must not execute");
    });
    await entered.promise;
    fence.close();
    release.resolve();
    await expect(write).rejects.toThrow("connection changed");
  });

  test("an exception releases the lease", async () => {
    await expect(
      withMcpCredentialLock("failed-operation", async () => {
        throw new Error("failure");
      }),
    ).rejects.toThrow("failure");
    expect(
      await withMcpCredentialLock(
        "failed-operation",
        async () => "recovered",
        0,
      ),
    ).toBe("recovered");
  });
});
