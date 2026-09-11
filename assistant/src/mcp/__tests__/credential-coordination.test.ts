import { createHash } from "node:crypto";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { getSignalsDir } from "../../util/platform.js";
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
  test("upgrades the legacy coordination schema without changing generations", async () => {
    const serverId = "legacy-lock-schema";
    await withMcpCredentialLock(serverId, async () => {});
    const db = new Database(
      join(getSignalsDir(), "mcp-credential-coordination.sqlite"),
    );
    try {
      db.exec("ALTER TABLE credential_locks DROP COLUMN owner_instance");
      db.exec("ALTER TABLE credential_locks DROP COLUMN cancellation_attempt");
      db.exec(
        "ALTER TABLE credential_locks DROP COLUMN teardown_remove_config",
      );
      const before = db
        .query(
          "SELECT server_key, generation FROM credential_locks ORDER BY server_key",
        )
        .all();
      await withMcpCredentialLock(serverId, async () => {});
      await withMcpCredentialLock(serverId, async () => {});
      expect(
        db
          .query(
            "SELECT server_key, generation FROM credential_locks ORDER BY server_key",
          )
          .all(),
      ).toEqual(before);
      expect(
        db
          .query<{ name: string }, []>("PRAGMA table_info(credential_locks)")
          .all()
          .filter((column) => column.name === "owner_instance"),
      ).toHaveLength(1);
      expect(
        db
          .query<{ name: string }, []>("PRAGMA table_info(credential_locks)")
          .all()
          .filter((column) => column.name === "cancellation_attempt"),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test.each(["cancellation", "remove", "revoke"])(
    "pending %s survives a crashed owner and blocks connections",
    async (kind) => {
      const serverId = `persisted-${kind}`;
      const existing = createMcpCredentialFence(serverId);
      const worker =
        child(`await withMcpCredentialLock("${serverId}", async (lease) => {
      ${
        kind === "cancellation"
          ? 'lease.setPendingCancellation("cancel-attempt");'
          : `lease.setPendingTeardown(${kind === "remove"});`
      }
      console.log("PERSISTED"); await Bun.stdin.text();
    });`);
      try {
        expect(await readLine(worker.stdout.getReader())).toBe("PERSISTED");
        worker.kill();
        await worker.exited;
        expect(() => createMcpCredentialFence(serverId)).toThrow(
          "cleanup is pending",
        );
        let wrote = false;
        await expect(
          existing.write(async () => {
            wrote = true;
          }),
        ).rejects.toThrow("MCP connection changed");
        expect(wrote).toBe(false);
        await withMcpCredentialLock(serverId, async (lease) => {
          if (kind === "cancellation") {
            expect(lease.pendingCancellation()).toBe("cancel-attempt");
          } else {
            expect(lease.pendingTeardown()).toBe(kind === "remove");
          }
          lease.setPendingCancellation(null);
          lease.setPendingTeardown(null);
          lease.advance();
        });
        const fresh = createMcpCredentialFence(serverId);
        expect(await fresh.write(async () => "connected")).toBe("connected");
      } finally {
        worker.kill();
      }
    },
  );

  test("a replacement process reclaims a stale lock with its reused PID", async () => {
    const serverId = "reused-owner-pid";
    await withMcpCredentialLock(serverId, async () => {});
    const db = new Database(
      join(getSignalsDir(), "mcp-credential-coordination.sqlite"),
    );
    try {
      db.query(
        "UPDATE credential_locks SET owner_pid = ?, owner_token = ?, owner_instance = ? WHERE server_key = ?",
      ).run(
        process.pid,
        "previous-lease",
        "previous-lease:os:previous-process-instance",
        createHash("sha256").update(serverId).digest("hex"),
      );
      expect(
        await withMcpCredentialLock(serverId, async () => "recovered", 0),
      ).toBe("recovered");
    } finally {
      db.close();
    }
  });

  test("a legacy lock owned by the replacement process is reclaimed", async () => {
    const serverId = "legacy-owner-pid";
    await withMcpCredentialLock(serverId, async () => {});
    const db = new Database(
      join(getSignalsDir(), "mcp-credential-coordination.sqlite"),
    );
    try {
      db.query(
        "UPDATE credential_locks SET owner_pid = ?, owner_token = ?, owner_instance = NULL WHERE server_key = ?",
      ).run(
        process.pid,
        "legacy-lease",
        createHash("sha256").update(serverId).digest("hex"),
      );
      expect(
        await withMcpCredentialLock(serverId, async () => "recovered", 0),
      ).toBe("recovered");
    } finally {
      db.close();
    }
  });

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

  test.each(["os:previous-process", "previous-lease:os:previous-process"])(
    "a live legacy writer is protected from stale identity metadata: %s",
    async (staleInstance) => {
      const serverId = "mixed-version-owner";
      const worker = child(`await withMcpCredentialLock(${JSON.stringify(
        serverId,
      )}, async () => {
        console.log("LOCKED"); await Bun.stdin.text();
      });`);
      const db = new Database(
        join(getSignalsDir(), "mcp-credential-coordination.sqlite"),
      );
      try {
        expect(await readLine(worker.stdout.getReader())).toBe("LOCKED");
        db.query(
          "UPDATE credential_locks SET owner_token = ?, owner_instance = ? WHERE server_key = ?",
        ).run(
          "legacy-reclaimed-lease",
          staleInstance,
          createHash("sha256").update(serverId).digest("hex"),
        );
        await expect(
          withMcpCredentialLock(serverId, async () => {}, 0),
        ).rejects.toThrow("storage is busy");
      } finally {
        worker.kill("SIGKILL");
        await worker.exited;
        db.close();
      }
      await withMcpCredentialLock(serverId, async () => {});
    },
  );

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
