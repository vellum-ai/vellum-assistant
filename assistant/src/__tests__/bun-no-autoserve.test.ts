import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * Guard for `assistant/docker-bun-no-autoserve.js`, the preload that stops
 * `bun:main` turning a CLI whose default export has a `fetch` method into a
 * long-lived HTTP server. The image has no Node, so `bunx <pkg>` runs such a
 * CLI under Bun via the `node` launcher the Dockerfile installs, and without
 * the shim the process never exits.
 *
 * The shim recognizes the implicit call by its `bun:main` caller frame. If a
 * Bun upgrade renames that frame the shim fails open (every server starts for
 * real) and these fixtures catch it.
 */

// Tests run with `assistant/` as the working directory.
const SHIM_PATH = join(process.cwd(), "docker-bun-no-autoserve.js");
const DOCKERFILE_PATH = join(process.cwd(), "Dockerfile");
const LAUNCHER_PATH = join(process.cwd(), "docker-node-launcher.sh");
const RUN_TIMEOUT_MS = 10_000;

let fixtureDir: string;

function writeFixture(name: string, source: string): string {
  const path = join(fixtureDir, name);
  writeFileSync(path, source);
  return path;
}

async function runWithShim(
  fixturePath: string,
): Promise<{ exitCode: number | null; output: string }> {
  const proc = Bun.spawn(
    [process.execPath, `--preload=${SHIM_PATH}`, "run", fixturePath],
    { stdout: "pipe", stderr: "pipe", windowsHide: true },
  );
  const timer = setTimeout(() => {
    proc.kill();
  }, RUN_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { exitCode: proc.exitCode, output: `${stdout}${stderr}` };
  } finally {
    clearTimeout(timer);
  }
}

describe("Bun auto-serve shim", () => {
  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "bun-no-autoserve-"));
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("a default export with fetch exits instead of starting a server", async () => {
    const fixture = writeFixture(
      "auto-serve.js",
      'export default { fetch: () => new Response("x") };\n',
    );

    const { exitCode, output } = await runWithShim(fixture);

    expect(exitCode).toBe(0);
    expect(output).not.toContain("Started ");
  });

  test("an explicit Bun.serve call still starts a real server", async () => {
    const fixture = writeFixture(
      "explicit-serve.js",
      [
        'const server = Bun.serve({ port: 0, fetch: () => new Response("x") });',
        // Written raw so Bun's console formatting does not colorize the number.
        'process.stdout.write("port=" + server.port + "\\n");',
        "server.stop(true);",
        "",
      ].join("\n"),
    );

    const { exitCode, output } = await runWithShim(fixture);

    expect(exitCode).toBe(0);
    const port = Number(/port=(\d+)/.exec(output)?.[1]);
    expect(port).toBeGreaterThan(0);
  });

  test("the Dockerfile installs the node launcher, which preloads the shim", () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");
    const launcher = readFileSync(LAUNCHER_PATH, "utf8");

    expect(dockerfile).toContain(
      "ln -s /app/assistant/docker-node-launcher.sh /usr/local/bin/node",
    );
    expect(launcher).toContain(
      "shim=/app/assistant/docker-bun-no-autoserve.js",
    );
    expect(launcher).toContain(
      'exec /usr/local/bin/bun --preload="$shim" "$@"',
    );
  });
});

// The launcher only falls back to Bun. A Node installed after the image was
// built (apt, or the persistent Kata apt root) has to win, or Node CLIs keep
// running under Bun semantics forever.
describe.skipIf(process.platform === "win32")(
  "node launcher PATH handoff",
  () => {
    let binDir: string;

    function writeStubNode(dir: string, marker: string): void {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "node");
      writeFileSync(path, `#!/bin/sh\necho ${marker}\n`);
      chmodSync(path, 0o755);
    }

    async function runLauncher(
      path: string,
    ): Promise<{ exitCode: number | null; output: string }> {
      const proc = Bun.spawn(["/bin/sh", LAUNCHER_PATH, "--version"], {
        env: { PATH: path },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      return { exitCode: proc.exitCode, output: `${stdout}${stderr}` };
    }

    beforeAll(() => {
      binDir = mkdtempSync(join(tmpdir(), "node-launcher-"));
    });

    afterAll(() => {
      rmSync(binDir, { recursive: true, force: true });
    });

    test("delegates to a real node found on PATH", async () => {
      const realDir = join(binDir, "real");
      writeStubNode(realDir, "REAL_NODE");

      const { exitCode, output } = await runLauncher(realDir);

      expect(exitCode).toBe(0);
      expect(output).toContain("REAL_NODE");
    });

    test("ignores Bun's own node shim dir", async () => {
      const shimDir = join(binDir, "bun-node-deadbeef");
      writeStubNode(shimDir, "BUN_SHIM");

      const { output } = await runLauncher(shimDir);

      // With no real node anywhere it falls through to the image's bun rather
      // than running the shim, which is the unpreloaded Bun that hangs.
      expect(output).not.toContain("BUN_SHIM");
    });
  },
);
