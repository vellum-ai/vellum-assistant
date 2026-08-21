import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00,
]);

let ipcResult: {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bodyEncoding?: "base64";
} = {
  ok: true,
  status: 200,
  headers: { "content-type": "application/octet-stream" },
  body: PNG_MAGIC.toString("base64"),
  bodyEncoding: "base64",
};

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async () => ({ ok: true, result: ipcResult }),
  exitFromIpcResult: (r: { error?: string }) => {
    throw new Error(r.error ?? "IPC error");
  },
}));

import { Command } from "commander";

import { applyCommandHelp } from "../../lib/cli-command-help.js";
import { registerRequestCommand } from "./request.js";
import { oauthHelp } from "./index.help.js";

let tempDir: string;

beforeEach(() => {
  process.exitCode = 0;
  tempDir = mkdtempSync(join(tmpdir(), "oauth-request-"));
  ipcResult = {
    ok: true,
    status: 200,
    headers: { "content-type": "application/octet-stream" },
    body: PNG_MAGIC.toString("base64"),
    bodyEncoding: "base64",
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
    const request = oauth.commands.find((command) => command.name() === "request");
    request?.option("--json");
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

describe("oauth request body output", () => {
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
    ipcResult = {
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
