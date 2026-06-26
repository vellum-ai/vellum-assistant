import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { runScript } from "../schedule/run-script.js";
import { SAFE_ENV_VARS } from "../tools/terminal/safe-env.js";

describe("runScript run token", () => {
  test("injects __SCHEDULE_RUN_TOKEN into the subprocess env", async () => {
    const result = await runScript('printf "%s" "$__SCHEDULE_RUN_TOKEN"', {
      cwd: tmpdir(),
      runToken: "secret-token-abc",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("secret-token-abc");
  });

  test("does not expose the token when runToken is omitted", async () => {
    const result = await runScript('printf "%s" "$__SCHEDULE_RUN_TOKEN"', {
      cwd: tmpdir(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("the token env var is absent from SAFE_ENV_VARS", () => {
    expect(SAFE_ENV_VARS).not.toContain("__SCHEDULE_RUN_TOKEN");
  });

  test("onSpawn receives the spawned subprocess", async () => {
    let spawned: Bun.Subprocess | null = null;
    await runScript("true", {
      cwd: tmpdir(),
      onSpawn: (proc) => {
        spawned = proc;
      },
    });

    expect(spawned).not.toBeNull();
    expect(typeof spawned!.pid).toBe("number");
  });
});
