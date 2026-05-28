import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { describe, expect, it } from "bun:test";

import {
  buildExecErrorMessage,
  exec,
  execOutput,
  execWithStdin,
} from "../step-runner";

describe("buildExecErrorMessage", () => {
  it("omits the argv from the header so secrets in args can't leak", () => {
    // Realistic shape — docker hatch invocations pass `-e <NAME>=<val>`
    // flags inline. If we ever regress and put argv in the header, this
    // assertion catches it immediately.
    const msg = buildExecErrorMessage("docker", 125, "stderr text", "");
    expect(msg).not.toContain("ANTHROPIC_API_KEY");
    expect(msg).not.toContain("OPENAI_API_KEY");
    expect(msg.startsWith("docker exited with code 125")).toBe(true);
  });

  it("appends stderr below the header when present", () => {
    const msg = buildExecErrorMessage("docker", 125, "  bind failed\n", "");
    expect(msg).toBe("docker exited with code 125\nbind failed");
  });

  it("appends stdout when stderr is empty", () => {
    const msg = buildExecErrorMessage("docker", 1, "", "stdout-only\n");
    expect(msg).toBe("docker exited with code 1\nstdout-only");
  });

  it("appends both streams joined by newline when both present", () => {
    const msg = buildExecErrorMessage("docker", 1, "stderr-line", "stdout-line");
    expect(msg).toBe("docker exited with code 1\nstderr-line\nstdout-line");
  });

  it("collapses an empty output to just the header", () => {
    const msg = buildExecErrorMessage("docker", 1, "  ", "\n");
    expect(msg).toBe("docker exited with code 1");
  });

  it("handles a null exit code (signal-terminated child)", () => {
    const msg = buildExecErrorMessage("docker", null, "killed", "");
    expect(msg).toBe("docker exited with an unknown code\nkilled");
  });
});

describe("exec — secret leak regression", () => {
  it("rejects with an Error whose message contains neither the args nor any -e KEY=VALUE pair", async () => {
    // The classic hatch failure shape: docker invoked with several
    // -e flags, exiting non-zero. Without the fix, args.join(" ")
    // would put `-e ANTHROPIC_API_KEY=sk-ant-…` into err.message.
    const fakeSecret = "sk-ant-this-should-never-appear-in-logs";
    try {
      await exec("sh", [
        "-c",
        `echo "bind for 0.0.0.0:20100 failed: port is already allocated" 1>&2 && exit 125`,
        "-e",
        `ANTHROPIC_API_KEY=${fakeSecret}`,
      ]);
      throw new Error("exec should have rejected");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(fakeSecret);
      expect(message).not.toContain("ANTHROPIC_API_KEY");
      expect(message).toContain("sh exited with code 125");
      expect(message).toContain("port is already allocated");
    }
  });
});

describe("execWithStdin — pipes input + no secret leak in errors", () => {
  it("writes the supplied input to the child's stdin", async () => {
    // Use sh `cat > path` to capture stdin to a real file we can inspect.
    // Mirrors the Docker-hatch overlay-staging call site shape.
    const workDir = mkdtempSync(join(tmpdir(), "step-runner-stdin-"));
    const dest = join(workDir, "captured.txt");
    try {
      const payload = '{"hello":"world"}\n';
      await execWithStdin("sh", ["-c", `cat > ${dest}`], payload);
      expect(readFileSync(dest, "utf-8")).toBe(payload);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects with an Error whose message contains neither the args nor any -e KEY=VALUE pair", async () => {
    const fakeSecret = "sk-anthropic-stdin-canary";
    try {
      await execWithStdin(
        "sh",
        [
          "-c",
          'echo "permission denied while trying to connect to docker daemon" 1>&2 && exit 1',
          "-e",
          `ANTHROPIC_API_KEY=${fakeSecret}`,
        ],
        "",
      );
      throw new Error("execWithStdin should have rejected");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(fakeSecret);
      expect(message).not.toContain("ANTHROPIC_API_KEY");
      expect(message).toContain("sh exited with code 1");
      expect(message).toContain("permission denied");
    }
  });
});

describe("execOutput — secret leak regression", () => {
  it("rejects with an Error whose message contains neither the args nor any -e KEY=VALUE pair", async () => {
    const fakeSecret = "sk-openai-leak-canary";
    try {
      await execOutput("sh", [
        "-c",
        `echo "no such container" 1>&2 && exit 1`,
        "-e",
        `OPENAI_API_KEY=${fakeSecret}`,
      ]);
      throw new Error("execOutput should have rejected");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(fakeSecret);
      expect(message).not.toContain("OPENAI_API_KEY");
      expect(message).toContain("sh exited with code 1");
      expect(message).toContain("no such container");
    }
  });
});
