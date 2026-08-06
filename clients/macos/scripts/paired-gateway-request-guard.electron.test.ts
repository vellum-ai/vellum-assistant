import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("Electron exposes the initiating frame for custom-protocol paired requests", async () => {
  if (process.platform !== "darwin") {
    return;
  }

  const electron = path.resolve(
    import.meta.dir,
    "../node_modules/.bin/electron",
  );
  const fixture = path.resolve(
    import.meta.dir,
    "fixtures/paired-gateway-request-guard",
  );
  const tempDir = mkdtempSync(
    path.join(os.tmpdir(), "paired-gateway-request-guard-"),
  );
  const resultPath = path.join(tempDir, "result.json");
  try {
    const processHandle = Bun.spawn([electron, fixture], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        PAIRED_GATEWAY_GUARD_RESULT_PATH: resultPath,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await processHandle.exited;
    expect(exitCode).toBe(0);

    const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
      trustedStatus: number;
      foreignStatus: number;
      pairedHandlerCalls: number;
      protocolHeaders: {
        origin: string | null;
        referer: string | null;
        secFetchSite: string | null;
      };
      observations: Array<{ frameOrigin: string | null }>;
    };
    expect(result).toEqual({
      trustedStatus: 200,
      foreignStatus: 0,
      pairedHandlerCalls: 1,
      protocolHeaders: {
        origin: null,
        referer: null,
        secFetchSite: null,
      },
      observations: [
        { frameOrigin: "paired-probe://vellum.ai" },
        { frameOrigin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) },
      ],
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}, 20_000);
