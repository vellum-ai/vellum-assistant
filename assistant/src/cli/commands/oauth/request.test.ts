import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00,
]);

const ipcCalls: string[] = [];
const handleRequestCalls: unknown[] = [];

let handleRequestResult: {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bodyEncoding?: "base64";
  account?: string | null;
  hint?: string;
} = {
  ok: true,
  status: 200,
  headers: { "content-type": "application/json" },
  body: { hello: "world" },
  account: "user@example.com",
};

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string) => {
    ipcCalls.push(method);
    return { ok: false, error: `Unexpected IPC method ${method}` };
  },
  exitFromIpcResult: (r: { error?: string }) => {
    throw new Error(r.error ?? "IPC error");
  },
  exitCodeFromIpcResult: (r: { statusCode?: number }) =>
    r.statusCode === undefined ? 10 : r.statusCode >= 500 ? 3 : 1,
}));

mock.module("../../../runtime/routes/oauth-commands-routes.js", () => ({
  handleRequest: async (args: unknown) => {
    handleRequestCalls.push(args);
    return handleRequestResult;
  },
}));

import { Command } from "commander";

import { applyCommandHelp } from "../../lib/cli-command-help.js";
import { oauthHelp } from "./index.help.js";
import { readBodyData, registerRequestCommand } from "./request.js";

let tempDir: string;

beforeEach(() => {
  ipcCalls.length = 0;
  handleRequestCalls.length = 0;
  process.exitCode = 0;
  tempDir = mkdtempSync(join(tmpdir(), "oauth-request-"));
  handleRequestResult = {
    ok: true,
    status: 200,
    headers: { "content-type": "application/json" },
    body: { hello: "world" },
    account: "user@example.com",
  };
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  process.exitCode = 0;
});

/**
 * Runs the command with both streams captured and `process.exit` recorded.
 * The stream stubs honour a write callback the way the real streams do, so an
 * exit that rides the last write lands in `exitCalls`, and only after every
 * chunk written before it has been captured. `holdStderr` keeps stderr
 * callbacks back and returns them, for the case where stderr is still in
 * flight when stdout has drained.
 */
async function runRequestCommand(
  args: string[],
  options: { holdStderr?: boolean } = {},
): Promise<{
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  exitCalls: number[];
  heldStderrCallbacks: Array<() => void>;
}> {
  const chunks: Buffer[] = [];
  const stderrChunks: string[] = [];
  const exitCalls: number[] = [];
  const heldStderrCallbacks: Array<() => void> = [];
  const originalWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalExit = process.exit;
  const callbackOf = (rest: unknown[]): (() => void) | undefined =>
    rest.find((arg) => typeof arg === "function") as (() => void) | undefined;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
    );
    callbackOf(rest)?.();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderrChunks.push(String(chunk));
    const callback = callbackOf(rest);
    if (callback) {
      if (options.holdStderr) {
        heldStderrCallbacks.push(holdCallback(callback));
      } else {
        callback();
      }
    }
    return true;
  }) as typeof process.stderr.write;
  const recordExit = ((code?: number) => {
    exitCalls.push(code ?? Number(process.exitCode ?? 0));
  }) as typeof process.exit;
  process.exit = recordExit;
  // A held callback runs after this function has restored the real
  // `process.exit`, so it reinstalls the recorder for the duration of the
  // call; the exit it triggers must land in `exitCalls`, never end the test
  // process.
  const holdCallback = (callback: () => void): (() => void) => {
    return () => {
      const current = process.exit;
      process.exit = recordExit;
      try {
        callback();
      } finally {
        process.exit = current;
      }
    };
  };

  try {
    const program = new Command();
    program.exitOverride();
    const oauth = program.command("oauth").description(oauthHelp.description);
    applyCommandHelp(oauth, oauthHelp);
    registerRequestCommand(oauth);
    const request = oauth.commands.find(
      (command) => command.name() === "request",
    );
    if (request) {
      request.option("--json");
    }
    await program.parseAsync(["node", "test", "oauth", "request", ...args]);
  } catch {
    // Commander may throw under exitOverride for parse errors.
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
  }

  return {
    stdout: Buffer.concat(chunks),
    stderr: stderrChunks.join(""),
    exitCode: Number(process.exitCode ?? 0),
    exitCalls,
    heldStderrCallbacks,
  };
}

describe("assistant oauth request", () => {
  test("runs handleRequest in-process and does not call IPC", async () => {
    const { stdout } = await runRequestCommand([
      "--provider",
      "google",
      "-s",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    ]);

    expect(ipcCalls).toEqual([]);
    expect(handleRequestCalls).toEqual([
      {
        body: {
          provider: "google",
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        },
      },
    ]);
    expect(stdout.toString("utf8")).toContain("hello");
  });
});

describe("oauth request body encoding", () => {
  const MULTIPART_BODY = [
    "--boundary",
    "Content-Type: application/json; charset=UTF-8",
    "",
    '{"name":"Sheet"}',
    "--boundary--",
    "",
  ].join("\r\n");

  const MULTIPART_HEADERS = {
    "Content-Type": "multipart/related; boundary=boundary",
  };

  test("keeps a multipart body as the exact string it was given", async () => {
    expect(readBodyData(MULTIPART_BODY, MULTIPART_HEADERS)).toBe(
      MULTIPART_BODY,
    );
  });

  test("parses a JSON body into an object", async () => {
    expect(
      readBodyData('{"name":"Sheet"}', {
        "Content-Type": "application/json",
      }),
    ).toEqual({ name: "Sheet" });
  });

  test("parses a JSON body when no Content-Type is given", async () => {
    expect(readBodyData('{"name":"Sheet"}', {})).toEqual({
      name: "Sheet",
    });
  });

  test("keeps a JSON-looking body raw under a non-JSON Content-Type", async () => {
    expect(
      readBodyData('{"name":"Sheet"}', { "content-type": "text/plain" }),
    ).toBe('{"name":"Sheet"}');
  });

  test("keeps unparseable text raw when no Content-Type is given", async () => {
    expect(readBodyData("not json at all", {})).toBe("not json at all");
  });

  test("reads a @file body under the caller's Content-Type", async () => {
    const filePath = join(tempDir, "upload.txt");
    writeFileSync(filePath, MULTIPART_BODY, "utf-8");

    expect(readBodyData(`@${filePath}`, MULTIPART_HEADERS)).toBe(
      MULTIPART_BODY,
    );
  });

  test("reads a binary @file as a Buffer without UTF-8 replacement", async () => {
    const filePath = join(tempDir, "upload.bin");
    writeFileSync(filePath, PNG_MAGIC);

    const parsed = readBodyData(`@${filePath}`, {
      "Content-Type": "application/octet-stream",
    });
    expect(Buffer.isBuffer(parsed)).toBe(true);
    expect(Buffer.from(parsed as Uint8Array).equals(PNG_MAGIC)).toBe(true);
  });

  test("forwards a binary @file to the route handler as a Buffer", async () => {
    const filePath = join(tempDir, "report.pdf");
    writeFileSync(filePath, PNG_MAGIC);

    const { exitCode } = await runRequestCommand([
      "--provider",
      "google",
      "-s",
      "-X",
      "POST",
      "-H",
      "Content-Type: application/pdf",
      "-d",
      `@${filePath}`,
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=media",
    ]);

    expect(exitCode).toBe(0);
    expect(handleRequestCalls).toHaveLength(1);
    const call = handleRequestCalls[0] as { body: { parsed_data: unknown } };
    expect(Buffer.isBuffer(call.body.parsed_data)).toBe(true);
    expect(
      Buffer.from(call.body.parsed_data as Uint8Array).equals(PNG_MAGIC),
    ).toBe(true);
  });

  test("forwards a multipart body to the route handler as a string", async () => {
    const { exitCode } = await runRequestCommand([
      "--provider",
      "google",
      "-s",
      "-X",
      "POST",
      "-H",
      "Content-Type: multipart/related; boundary=boundary",
      "-d",
      MULTIPART_BODY,
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    ]);

    expect(exitCode).toBe(0);
    expect(handleRequestCalls).toEqual([
      {
        body: {
          provider: "google",
          url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
          method: "POST",
          headers: {
            "Content-Type": "multipart/related; boundary=boundary",
          },
          parsed_data: MULTIPART_BODY,
        },
      },
    ]);
  });
});

describe("oauth request body output", () => {
  beforeEach(() => {
    handleRequestResult = {
      ok: true,
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      body: PNG_MAGIC.toString("base64"),
      bodyEncoding: "base64",
    };
  });

  test("decodes a base64 envelope to raw bytes when writing a file", async () => {
    const outputPath = join(tempDir, "drive.bin");
    const { exitCode } = await runRequestCommand([
      "--provider",
      "google",
      "-s",
      "-o",
      outputPath,
      "https://www.googleapis.com/drive/v3/files/file-123?alt=media",
    ]);

    expect(exitCode).toBe(0);
    expect(readFileSync(outputPath).equals(PNG_MAGIC)).toBe(true);
  });

  test("writes raw binary bytes to stdout without an extra newline", async () => {
    const { stdout, exitCode } = await runRequestCommand([
      "--provider",
      "google",
      "-s",
      "https://www.googleapis.com/drive/v3/files/file-123?alt=media",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.equals(PNG_MAGIC)).toBe(true);
  });

  test("keeps the encoded envelope in --json mode", async () => {
    const { stdout, exitCode } = await runRequestCommand([
      "--json",
      "--provider",
      "google",
      "-s",
      "https://www.googleapis.com/drive/v3/files/file-123?alt=media",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.toString("utf8")) as {
      body: string;
      bodyEncoding?: string;
    };
    expect(parsed.body).toBe(PNG_MAGIC.toString("base64"));
    expect(parsed.bodyEncoding).toBe("base64");
  });

  test("exits non-zero when the route reports failure inside a 2xx", async () => {
    // The exit code follows the route's verdict, so a caller that only checks
    // the exit code sees a refused call as a failure; the body still prints,
    // since it carries the provider's own error code.
    handleRequestResult = {
      ok: false,
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: false, error: "not_in_channel" },
      account: "user@example.com",
    };
    const { stdout, exitCode } = await runRequestCommand([
      "--provider",
      "slack_channel",
      "-s",
      "/chat.postMessage",
    ]);

    expect(exitCode).toBe(1);
    expect(stdout.toString("utf8")).toContain("not_in_channel");
  });

  test("exits itself once the whole body has drained", async () => {
    // The in-process route leaves handles open, so the command has to exit;
    // and it must do so on the write callback, because a bare exit after a
    // large piped write drops everything past the first 64 KB.
    const body = "x".repeat(200_000);
    handleRequestResult = {
      ok: true,
      status: 200,
      headers: { "content-type": "text/plain" },
      body,
      account: "user@example.com",
    };
    const { stdout, exitCode, exitCalls } = await runRequestCommand([
      "--provider",
      "google",
      "-s",
      "https://api.google.com/v1/big",
    ]);

    expect(stdout.toString("utf8")).toBe(body + "\n");
    expect(exitCode).toBe(0);
    expect(exitCalls).toEqual([0]);
  });

  test("exits after writing an empty body to a file", async () => {
    const target = join(tempDir, "empty.bin");
    handleRequestResult = {
      ok: true,
      status: 204,
      headers: {},
      body: null,
      account: "user@example.com",
    };
    const { exitCalls } = await runRequestCommand([
      "--provider",
      "google",
      "-s",
      "-o",
      target,
      "https://api.google.com/v1/none",
    ]);

    expect(readFileSync(target)).toHaveLength(0);
    expect(exitCalls).toEqual([0]);
  });

  test("waits for stderr to drain before exiting when stdout carried nothing", async () => {
    // With `-o`, stdout carries nothing, so the exit cannot ride a stdout
    // write, and the diagnostics on stderr (the account line, a hint) may
    // still be in flight. The exit waits for the last of them.
    const target = join(tempDir, "body.json");
    handleRequestResult = {
      ok: false,
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: false, error: "not_in_channel" },
      account: "user@example.com",
      hint: "slack_channel answered HTTP 200 but reported ok: false",
    };
    const { stderr, exitCalls, heldStderrCallbacks } = await runRequestCommand(
      ["--provider", "slack_channel", "-o", target, "/chat.postMessage"],
      { holdStderr: true },
    );

    expect(stderr).toContain("Account: user@example.com");
    expect(stderr).toContain("ok: false");
    expect(heldStderrCallbacks).toHaveLength(2);
    expect(exitCalls).toEqual([]);

    heldStderrCallbacks[0]();
    expect(exitCalls).toEqual([]);
    heldStderrCallbacks[1]();
    expect(exitCalls).toEqual([1]);
  });

  test("a stdout body waits for stderr diagnostics written before it", async () => {
    handleRequestResult = {
      ok: true,
      status: 200,
      headers: { "content-type": "application/json" },
      body: { hello: "world" },
      account: "user@example.com",
    };
    const { stdout, exitCalls, heldStderrCallbacks } = await runRequestCommand(
      ["--provider", "google", "https://api.google.com/v1/me"],
      { holdStderr: true },
    );

    expect(stdout.toString("utf8")).toContain("hello");
    expect(heldStderrCallbacks).toHaveLength(1);
    expect(exitCalls).toEqual([]);

    heldStderrCallbacks[0]();
    expect(exitCalls).toEqual([0]);
  });

  test("writes text bodies as UTF-8 and appends a newline on stdout", async () => {
    handleRequestResult = {
      ok: true,
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "hello café",
    };

    const { stdout, exitCode } = await runRequestCommand([
      "--provider",
      "google",
      "-s",
      "https://www.googleapis.com/drive/v3/files/file-123",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.toString("utf8")).toBe("hello café\n");
  });
});
