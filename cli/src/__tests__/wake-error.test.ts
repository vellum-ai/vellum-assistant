import { expect, test } from "bun:test";
import { resolveLockfilePaths } from "@vellumai/local-mode";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

test("CLI wake emits actionable structured identity error and exits 1 without mutating state", async () => {
  const root = mkdtempSync(join(tmpdir(), "wake-error-"));
  try {
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      VELLUM_ENVIRONMENT: "local",
      VELLUM_LOCKFILE_DIR: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
    };
    const registry = resolveLockfilePaths(env)[0]!;
    mkdirSync(dirname(registry), { recursive: true });
    const original = JSON.stringify({
      assistants: [
        {
          assistantId: "example",
          cloud: "local",
          runtimeUrl: "http://127.0.0.1:27830",
          resources: {
            instanceDir: join(root, "instance"),
            daemonPort: 27821,
            gatewayPort: 27830,
            cesPort: 27822,
            qdrantPort: 26333,
          },
        },
      ],
    });
    writeFileSync(registry, original);
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../index.ts"),
        "wake",
        "example",
      ],
      {
        env,
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    );
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(1);
    const line = stderr
      .split("\n")
      .find((value) => value.startsWith("CLI_ERROR:"));
    expect(line).toBeDefined();
    const payload = JSON.parse(line!.slice("CLI_ERROR:".length));
    expect(payload.error).toBe("AUTH_IDENTITY_UNAVAILABLE");
    expect(payload.detail).toBe("missing");
    expect(payload.message).toContain(
      'vellum wake "example" --repair-guardian',
    );
    expect(payload.message).toContain("all clients to authenticate again");
    expect(readFileSync(registry, "utf8")).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
