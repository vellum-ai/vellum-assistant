/**
 * Tests for the `cloud: "paired"` lifecycle guards: `vellum wake`/`vellum sleep`
 * must refuse a remote pairing with a clear "managed on its host machine"
 * message instead of treating it as an on-machine process.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "paired-lifecycle-test-"));
const ORIGINAL_LOCKFILE_DIR = process.env.VELLUM_LOCKFILE_DIR;
const ORIGINAL_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_ARGV = [...process.argv];

import { saveAssistantEntry } from "../lib/assistant-config.js";
import { retire } from "../commands/retire.js";
import { sleep } from "../commands/sleep.js";
import { wake } from "../commands/wake.js";

function seedPairedEntry(): void {
  saveAssistantEntry({
    assistantId: "px",
    name: "Paired Box",
    runtimeUrl: "http://10.0.0.9:7830",
    cloud: "paired",
    paired: true,
    species: "vellum",
  });
}

/** Run `fn` with console.error + process.exit spied; return {exited, errors}. */
async function runGuarded(
  fn: () => Promise<void>,
): Promise<{ exited: boolean; errors: string }> {
  const errors: string[] = [];
  const errSpy = spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => {
      errors.push(a.join(" "));
    },
  );
  const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
    throw new Error(`exit:${c}`);
  }) as never);
  let exited = false;
  try {
    await fn();
  } catch (e) {
    exited = (e as Error).message === "exit:1";
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { exited, errors: errors.join("\n") };
}

describe("paired lifecycle guards", () => {
  beforeEach(() => {
    process.env.VELLUM_LOCKFILE_DIR = testDir;
    process.env.XDG_CONFIG_HOME = testDir;
    seedPairedEntry();
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    if (ORIGINAL_LOCKFILE_DIR === undefined)
      delete process.env.VELLUM_LOCKFILE_DIR;
    else process.env.VELLUM_LOCKFILE_DIR = ORIGINAL_LOCKFILE_DIR;
    if (ORIGINAL_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ORIGINAL_CONFIG_HOME;
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("wake refuses a paired entry with a host-machine message", async () => {
    process.argv = ["bun", "vellum", "wake", "px"];
    const { exited, errors } = await runGuarded(wake);

    expect(exited).toBe(true);
    expect(errors).toContain("paired from another machine");
    expect(errors).toContain("vellum client px");
    // It must NOT fall through to the generic local/docker guard.
    expect(errors).not.toContain("only works with local and docker");
  });

  test("sleep refuses a paired entry with a host-machine message", async () => {
    process.argv = ["bun", "vellum", "sleep", "px"];
    const { exited, errors } = await runGuarded(sleep);

    expect(exited).toBe(true);
    expect(errors).toContain("paired from another machine");
    expect(errors).toContain("vellum client px");
    expect(errors).not.toContain("only works with local and docker");
  });

  test("retire refuses a paired entry and points to unpair", async () => {
    process.argv = ["bun", "vellum", "retire", "px", "--yes"];
    const { exited, errors } = await runGuarded(retire);

    expect(exited).toBe(true);
    expect(errors).toContain("paired from another machine");
    expect(errors).toContain("vellum unpair");
    // It must NOT fall through to the generic "Unknown cloud type" path.
    expect(errors).not.toContain("Unknown cloud type");
  });
});
