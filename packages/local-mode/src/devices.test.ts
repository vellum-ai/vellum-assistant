import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

import type { CliInvocation } from "./util";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = mock(() => true);
}

let lastChild: FakeChild;
const spawnArgs: Array<[string, string[], { stdio?: unknown; windowsHide?: boolean }]> = [];
const spawnMock = mock(
  (command: string, args: string[], options: { stdio?: unknown; windowsHide?: boolean }) => {
    spawnArgs.push([command, args, options]);
    lastChild = new FakeChild();
    return lastChild;
  },
);

mock.module("node:child_process", () => ({ spawn: spawnMock }));

let runDevicesList: typeof import("./devices").runDevicesList;
let runDevicesRevoke: typeof import("./devices").runDevicesRevoke;

beforeAll(async () => {
  ({ runDevicesList, runDevicesRevoke } = await import("./devices"));
});

afterEach(() => {
  spawnArgs.length = 0;
  spawnMock.mockClear();
});

const invocation: CliInvocation = { command: "bun", baseArgs: ["run", "cli"] };

describe("runDevicesList", () => {
  test("spawns the CLI devices command and parses the JSON document", async () => {
    const pending = runDevicesList(invocation, "asst-42");
    lastChild.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          devices: [
            {
              hashedDeviceId: "hash-a",
              platform: "ios",
              issuedAt: 1000,
              expiresAt: 2000,
              lastUsedAt: 1500,
            },
          ],
        }),
      ),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({
      ok: true,
      devices: [
        {
          hashedDeviceId: "hash-a",
          platform: "ios",
          issuedAt: 1000,
          expiresAt: 2000,
          lastUsedAt: 1500,
        },
      ],
    });
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", "cli", "devices", "asst-42", "--json"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    ]);
  });

  test("tolerates null and non-numeric timestamps", async () => {
    const pending = runDevicesList(invocation, "asst-42");
    lastChild.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          devices: [
            {
              hashedDeviceId: "hash-b",
              platform: "web",
              issuedAt: null,
              expiresAt: "soon",
            },
          ],
        }),
      ),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({
      ok: true,
      devices: [
        {
          hashedDeviceId: "hash-b",
          platform: "web",
          issuedAt: null,
          expiresAt: null,
          lastUsedAt: null,
        },
      ],
    });
  });

  test("passes isCurrentHost through only when literally true", async () => {
    const pending = runDevicesList(invocation, "asst-42");
    lastChild.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          devices: [
            {
              hashedDeviceId: "hash-host",
              platform: "cli",
              issuedAt: 1000,
              expiresAt: null,
              lastUsedAt: null,
              isCurrentHost: true,
            },
            {
              hashedDeviceId: "hash-truthy",
              platform: "ios",
              issuedAt: 1000,
              expiresAt: null,
              lastUsedAt: null,
              isCurrentHost: "yes",
            },
            {
              hashedDeviceId: "hash-false",
              platform: "ios",
              issuedAt: 1000,
              expiresAt: null,
              lastUsedAt: null,
              isCurrentHost: false,
            },
          ],
        }),
      ),
    );
    lastChild.emit("close", 0);

    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.devices.map((d) => d.isCurrentHost)).toEqual([
        true,
        undefined,
        undefined,
      ]);
      expect("isCurrentHost" in result.devices[1]!).toBe(false);
    }
  });

  test("an empty device list parses to no records", async () => {
    const pending = runDevicesList(invocation, "asst-42");
    lastChild.stdout.emit("data", Buffer.from('{ "devices": [] }'));
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, devices: [] });
  });

  test("malformed stdout resolves to a failure with a snippet", async () => {
    const pending = runDevicesList(invocation, "asst-42");
    lastChild.stdout.emit("data", Buffer.from("not json"));
    lastChild.emit("close", 0);

    expect(await pending).toEqual({
      ok: false,
      error: "CLI returned unparseable devices output: not json",
    });
  });

  test("a record missing hashedDeviceId resolves to a failure", async () => {
    const pending = runDevicesList(invocation, "asst-42");
    lastChild.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ devices: [{ platform: "ios" }] })),
    );
    lastChild.emit("close", 0);

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toStartWith("CLI returned unparseable devices output");
    }
  });

  test("a non-zero exit resolves to a failure carrying stderr", async () => {
    const pending = runDevicesList(invocation, "asst-42");
    lastChild.stderr.emit("data", Buffer.from("devices failed"));
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      error: "devices failed",
    });
  });

  test("a spawn error resolves to a failure", async () => {
    const pending = runDevicesList(invocation, "asst-42");
    lastChild.emit("error", new Error("ENOENT"));

    expect(await pending).toEqual({
      ok: false,
      error: "Failed to spawn CLI: ENOENT",
    });
  });
});

describe("runDevicesRevoke", () => {
  test("spawns the CLI revoke command and succeeds on exit 0", async () => {
    const pending = runDevicesRevoke(invocation, "asst-42", "hash-a");
    lastChild.stdout.emit(
      "data",
      Buffer.from('{ "ok": true, "hashedDeviceId": "hash-a" }'),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", "cli", "devices", "revoke", "hash-a", "asst-42", "--yes", "--json"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    ]);
  });

  test("a non-zero exit resolves to a failure carrying stderr", async () => {
    const pending = runDevicesRevoke(invocation, "asst-42", "hash-a");
    lastChild.stderr.emit("data", Buffer.from("revoke failed"));
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      error: "revoke failed",
    });
  });

  test("a spawn error resolves to a failure", async () => {
    const pending = runDevicesRevoke(invocation, "asst-42", "hash-a");
    lastChild.emit("error", new Error("EACCES"));

    expect(await pending).toEqual({
      ok: false,
      error: "Failed to spawn CLI: EACCES",
    });
  });

  test("multi-line stderr with a trailing Error: line surfaces just that message", async () => {
    const pending = runDevicesRevoke(invocation, "asst-42", "hash-a");
    lastChild.stderr.emit(
      "data",
      Buffer.from(
        [
          "Device to revoke:",
          "  Platform: ios",
          "  Issued:   2026-01-01",
          "",
          "Error: Gateway is unreachable",
          "",
        ].join("\n"),
      ),
    );
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      error: "Gateway is unreachable",
    });
  });

  test("stderr without an Error: line falls back to the whole stderr", async () => {
    const pending = runDevicesRevoke(invocation, "asst-42", "hash-a");
    lastChild.stderr.emit(
      "data",
      Buffer.from("Device to revoke:\n  Platform: ios\n"),
    );
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      error: "Device to revoke:\n  Platform: ios",
    });
  });
});
