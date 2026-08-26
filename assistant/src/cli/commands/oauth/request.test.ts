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

async function runRequestCommand(args: string[]): Promise<{
  stdout: Buffer;
  exitCode: number;
}> {
  const chunks: Buffer[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
    );
    return true;
  }) as typeof process.stdout.write;

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
  }

  return {
    stdout: Buffer.concat(chunks),
    exitCode: Number(process.exitCode ?? 0),
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
