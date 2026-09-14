import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// The command runs the file route in-process, as `oauth request` does, so a
// large file never crosses IPC. The route is stubbed so the tests see what
// path parameters the command hands it; IPC is stubbed to prove the command
// never takes that path. The exit-code helper stays real.
const ipcCalls: string[] = [];
const handleCalls: Array<Record<string, unknown>> = [];
let handleImpl: () => Promise<unknown>;

const actualCliClient = await import("../../../../ipc/cli-client.js");
mock.module("../../../../ipc/cli-client.js", () => ({
  ...actualCliClient,
  cliIpcCall: async (method: string) => {
    ipcCalls.push(method);
    return { ok: false, error: `Unexpected IPC method ${method}` };
  },
}));

const actualRoutes =
  await import("../../../../runtime/routes/channel-file-routes.js");
mock.module("../../../../runtime/routes/channel-file-routes.js", () => ({
  ...actualRoutes,
  handleChannelFile: async (args: Record<string, unknown>) => {
    handleCalls.push(args);
    return handleImpl();
  },
}));

import type { Command } from "commander";

import { runCliCommand } from "../../__tests__/cli-test-harness.js";
import { registerChannelsCommand } from "../index.js";

const { BadRequestError } =
  await import("../../../../runtime/routes/errors.js");

const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const ENVELOPE = {
  channel: "slack",
  fileId: "F1",
  filename: "shot.png",
  mimeType: "image/png",
  size: BYTES.length,
  body: BYTES.toString("base64"),
  bodyEncoding: "base64" as const,
};

let dir: string;

beforeEach(() => {
  ipcCalls.length = 0;
  handleCalls.length = 0;
  handleImpl = async () => ENVELOPE;
  dir = mkdtempSync(join(tmpdir(), "channels-file-"));
});

function registerChannels(program: Command): void {
  registerChannelsCommand(program);
  program.commands
    .find((c) => c.name() === "channels")
    ?.commands.find((c) => c.name() === "file")
    ?.option("--json");
}

function runChannelsFile(args: string[]) {
  return runCliCommand(registerChannels, ["channels", "file", ...args]);
}

describe("channels file", () => {
  test("runs the route in-process with the channel and file id, and writes the bytes with -o", async () => {
    const out = join(dir, "shot.png");
    const run = await runChannelsFile(["slack", "F1", "-o", out]);

    expect(ipcCalls).toEqual([]);
    expect(handleCalls).toEqual([
      { pathParams: { channel: "slack", fileId: "F1" }, queryParams: {} },
    ]);
    expect(readFileSync(out)).toEqual(BYTES);
    expect(run.stderr).toContain("Wrote 4 bytes (image/png)");
    expect(run.exitCode).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("passes --account through as the query the route reads", async () => {
    await runChannelsFile(["slack", "F1", "--account", "T123", "--json"]);
    expect(handleCalls[0]).toEqual({
      pathParams: { channel: "slack", fileId: "F1" },
      queryParams: { account: "T123" },
    });
  });

  test("--json names the file and leaves the bytes out", async () => {
    const out = join(dir, "shot.png");
    const run = await runChannelsFile(["slack", "F1", "-o", out, "--json"]);
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(parsed).toEqual({
      channel: "slack",
      fileId: "F1",
      filename: "shot.png",
      mimeType: "image/png",
      size: 4,
      output: out,
    });
    expect(run.stdout).not.toContain(BYTES.toString("base64"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("a route refusal is reported with the channel diagnostics hint and the route's exit code", async () => {
    handleImpl = async () => {
      throw new BadRequestError(
        'Channel "discord" cannot fetch a file by id. Channels that can: slack.',
      );
    };
    const run = await runChannelsFile(["discord", "F1"]);
    expect(run.stderr).toContain("cannot fetch a file by id");
    expect(run.stderr).toContain("channels get discord");
    expect(run.exitCode).toBe(
      actualCliClient.exitCodeFromIpcResult({ statusCode: 400 }),
    );
    expect(handleCalls).toHaveLength(1);
  });
});
