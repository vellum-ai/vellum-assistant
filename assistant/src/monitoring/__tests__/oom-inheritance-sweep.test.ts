import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { sweepInheritedOomProtection } from "../oom-inheritance-sweep.js";
import { stat } from "./proc-fixtures.js";

const DAEMON = 100;
const MONITOR = 200;

let procRoot: string;

function writeProcess(
  pid: number,
  ppid: number,
  comm: string,
  oomScoreAdj: number | null,
): void {
  const dir = join(procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stat"), stat(pid, comm, "S", ppid, 100));
  if (oomScoreAdj != null) {
    writeFileSync(join(dir, "oom_score_adj"), `${oomScoreAdj}\n`);
  }
}

function readAdj(pid: number): string {
  return readFileSync(join(procRoot, String(pid), "oom_score_adj"), "utf-8");
}

beforeEach(() => {
  procRoot = mkdtempSync(join(tmpdir(), "oom-sweep-"));
  writeProcess(1, 0, "init", 0);
  writeProcess(DAEMON, 1, "bun", -700);
  writeProcess(MONITOR, DAEMON, "bun", -500);
});

afterEach(() => {
  rmSync(procRoot, { recursive: true, force: true });
});

describe("sweepInheritedOomProtection", () => {
  test("resets negative descendants and leaves everything else alone", () => {
    writeProcess(300, DAEMON, "node", -700); // forgot to reset
    writeProcess(400, 300, "python3", -700); // inherited through 300
    writeProcess(500, 1, "sshd", -700); // not under the daemon
    writeProcess(600, DAEMON, "bash", 1000); // already raised
    writeProcess(700, DAEMON, "zombie", null); // no oom_score_adj file

    const resets = sweepInheritedOomProtection({
      daemonPid: DAEMON,
      keepPids: new Set([MONITOR]),
      procRoot,
    });

    expect(resets.sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 300, comm: "node", previous: -700 },
      { pid: 400, comm: "python3", previous: -700 },
    ]);
    expect(readAdj(300)).toBe("0");
    expect(readAdj(400)).toBe("0");
    expect(readAdj(DAEMON)).toBe("-700\n");
    expect(readAdj(MONITOR)).toBe("-500\n");
    expect(readAdj(500)).toBe("-700\n");
    expect(readAdj(600)).toBe("1000\n");
  });

  test("tolerates a ppid cycle in a malformed table", () => {
    writeProcess(300, 400, "a", -700);
    writeProcess(400, 300, "b", -700);
    expect(
      sweepInheritedOomProtection({
        daemonPid: DAEMON,
        keepPids: new Set([MONITOR]),
        procRoot,
      }),
    ).toEqual([]);
  });
});
