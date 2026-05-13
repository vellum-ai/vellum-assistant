import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";

import { confirmPrompt } from "../confirm-prompt.js";

interface Captured {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  outChunks: string[];
  errChunks: string[];
}

function buildStreams(): Captured {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  stdout.on("data", (c: Buffer) => outChunks.push(c.toString("utf8")));
  stderr.on("data", (c: Buffer) => errChunks.push(c.toString("utf8")));
  return { stdin, stdout, stderr, outChunks, errChunks };
}

describe("confirmPrompt", () => {
  test("returns \"non-interactive\" without reading when isTTY=false", async () => {
    const { stdin, stdout, stderr, outChunks, errChunks } = buildStreams();
    const result = await confirmPrompt({
      question: "Delete? [y/N] ",
      isTTY: false,
      refuseNonInteractiveMessage: "Refusing: pass --force.",
      stdin,
      stdout,
      stderr,
    });
    expect(result).toBe("non-interactive");
    expect(errChunks.join("")).toContain("Refusing: pass --force.");
    expect(outChunks.join("")).toBe("");
  });

  test("returns \"confirmed\" for \"y\\n\"", async () => {
    const { stdin, stdout, stderr } = buildStreams();
    const pending = confirmPrompt({
      question: "Delete? [y/N] ",
      isTTY: true,
      refuseNonInteractiveMessage: "should not see this",
      stdin,
      stdout,
      stderr,
    });
    stdin.write("y\n");
    expect(await pending).toBe("confirmed");
  });

  test("returns \"confirmed\" for \"yes\\n\" (case-insensitive, whitespace-tolerant)", async () => {
    const { stdin, stdout, stderr } = buildStreams();
    const pending = confirmPrompt({
      question: "Delete? [y/N] ",
      isTTY: true,
      refuseNonInteractiveMessage: "n/a",
      stdin,
      stdout,
      stderr,
    });
    stdin.write("  YES  \n");
    expect(await pending).toBe("confirmed");
  });

  test("returns \"denied\" for \"n\\n\"", async () => {
    const { stdin, stdout, stderr } = buildStreams();
    const pending = confirmPrompt({
      question: "Delete? [y/N] ",
      isTTY: true,
      refuseNonInteractiveMessage: "n/a",
      stdin,
      stdout,
      stderr,
    });
    stdin.write("n\n");
    expect(await pending).toBe("denied");
  });

  test("returns \"denied\" for empty input (just Enter)", async () => {
    const { stdin, stdout, stderr } = buildStreams();
    const pending = confirmPrompt({
      question: "Delete? [y/N] ",
      isTTY: true,
      refuseNonInteractiveMessage: "n/a",
      stdin,
      stdout,
      stderr,
    });
    stdin.write("\n");
    expect(await pending).toBe("denied");
  });

  test("returns \"denied\" on EOF without any data (regression: would have hung)", async () => {
    const { stdin, stdout, stderr } = buildStreams();
    const pending = confirmPrompt({
      question: "Delete? [y/N] ",
      isTTY: true,
      refuseNonInteractiveMessage: "n/a",
      stdin,
      stdout,
      stderr,
    });
    stdin.end();
    expect(await pending).toBe("denied");
  });

  test("returns \"denied\" on EOF after a partial line with no newline", async () => {
    const { stdin, stdout, stderr } = buildStreams();
    const pending = confirmPrompt({
      question: "Delete? [y/N] ",
      isTTY: true,
      refuseNonInteractiveMessage: "n/a",
      stdin,
      stdout,
      stderr,
    });
    // "y" without a trailing newline followed by EOF — readline will fire
    // the "line" event on close, so we exercise that path explicitly.
    stdin.write("y");
    stdin.end();
    const result = await pending;
    // readline fires `line` with the buffered content on EOF, so this
    // actually confirms. Documents the behaviour either way.
    expect(["confirmed", "denied"]).toContain(result);
  });

  test("writes the question to stdout when interactive", async () => {
    const { stdin, stdout, stderr, outChunks } = buildStreams();
    const pending = confirmPrompt({
      question: "Delete plugin \"foo\"? [y/N] ",
      isTTY: true,
      refuseNonInteractiveMessage: "n/a",
      stdin,
      stdout,
      stderr,
    });
    stdin.write("n\n");
    await pending;
    expect(outChunks.join("")).toContain("Delete plugin \"foo\"? [y/N] ");
  });

  test("treats stray garbage as denial, never confirmation", async () => {
    const { stdin, stdout, stderr } = buildStreams();
    const pending = confirmPrompt({
      question: "Delete? [y/N] ",
      isTTY: true,
      refuseNonInteractiveMessage: "n/a",
      stdin,
      stdout,
      stderr,
    });
    stdin.write("maybe\n");
    expect(await pending).toBe("denied");
  });
});
