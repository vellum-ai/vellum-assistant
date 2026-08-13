import { afterAll, describe, expect, mock, test } from "bun:test";

import {
  classifyProcess,
  detectOrphanedProcesses,
  isInteractiveCliSession,
} from "./orphan-detection.js";

// `mock.restore()` does not undo `mock.module()`; keep the real module so it
// can be restored in afterAll for later test files in the same run.
const realStepRunner = { ...(await import("./step-runner")) };

describe("isInteractiveCliSession", () => {
  test("matches a live tunnel session launched via a script path", () => {
    expect(
      isInteractiveCliSession(
        "bun /Users/x/.nvm/versions/node/v22.14.0/bin/vellum tunnel --provider ngrok",
      ),
    ).toBe(true);
  });

  test("matches interactive subcommands like logs and terminal", () => {
    expect(isInteractiveCliSession("vellum logs foo")).toBe(true);
    expect(isInteractiveCliSession("vellum terminal")).toBe(true);
  });

  test("matches the other long-running interactive subcommands", () => {
    expect(isInteractiveCliSession("vellum events")).toBe(true);
    expect(isInteractiveCliSession("vellum client")).toBe(true);
    expect(isInteractiveCliSession("vellum ssh quiet-finch")).toBe(true);
    expect(isInteractiveCliSession("vellum message quiet-finch hi")).toBe(true);
    expect(isInteractiveCliSession("vellum workflows")).toBe(true);
    expect(isInteractiveCliSession("vellum-cli tunnel --provider ngrok")).toBe(
      true,
    );
  });

  test("allows the known global flags before the subcommand", () => {
    expect(isInteractiveCliSession("vellum --plain tunnel")).toBe(true);
    expect(isInteractiveCliSession("vellum --no-color logs foo")).toBe(true);
    expect(isInteractiveCliSession("vellum --no-color --plain events")).toBe(
      true,
    );
  });

  test("matches exec sessions even when argv mentions a service name", () => {
    expect(
      isInteractiveCliSession(
        "vellum exec -it --service vellum-gateway -- /bin/sh",
      ),
    ).toBe(true);
  });

  test("does not match non-interactive CLI wrappers", () => {
    expect(isInteractiveCliSession("vellum hatch")).toBe(false);
    expect(isInteractiveCliSession("/usr/bin/vellum sleep")).toBe(false);
    expect(isInteractiveCliSession("vellum wake")).toBe(false);
    expect(isInteractiveCliSession("vellum wake --watch")).toBe(false);
  });

  test("matches the implicit TUI client (bare vellum)", () => {
    expect(isInteractiveCliSession("vellum")).toBe(true);
    expect(isInteractiveCliSession("bun /Users/x/.nvm/bin/vellum")).toBe(true);
    expect(isInteractiveCliSession("vellum --plain")).toBe(true);
  });

  test("matches a foreground wake session", () => {
    expect(isInteractiveCliSession("vellum wake --foreground")).toBe(true);
    expect(isInteractiveCliSession("vellum wake --watch --foreground")).toBe(
      true,
    );
    expect(
      isInteractiveCliSession("bun /Users/x/bin/vellum wake --foreground"),
    ).toBe(true);
  });

  test("interactive names in later argv tokens do not match", () => {
    expect(isInteractiveCliSession("vellum hatch --name logs")).toBe(false);
    expect(isInteractiveCliSession("vellum sleep logs")).toBe(false);
  });

  test("unknown flags before the subcommand do not match", () => {
    expect(isInteractiveCliSession("vellum --verbose tunnel")).toBe(false);
  });

  test("repo paths containing vellum do not match", () => {
    expect(
      isInteractiveCliSession(
        "node /Users/runner/work/vellum-assistant/vellum-assistant/scripts/build.js",
      ),
    ).toBe(false);
  });
});

describe("classifyProcess", () => {
  test("labels interactive CLI sessions as vellum like any other wrapper", () => {
    expect(classifyProcess("vellum tunnel --provider ngrok")).toBe("vellum");
    expect(classifyProcess("vellum logs foo")).toBe("vellum");
    expect(classifyProcess("vellum-cli tunnel --provider ngrok")).toBe(
      "vellum",
    );
  });

  test("classifies non-interactive CLI wrappers as vellum", () => {
    expect(classifyProcess("vellum hatch")).toBe("vellum");
    expect(classifyProcess("vellum")).toBe("vellum");
    expect(classifyProcess("/usr/bin/vellum sleep")).toBe("vellum");
    expect(classifyProcess("vellum hatch --name logs")).toBe("vellum");
    expect(classifyProcess("vellum sleep logs")).toBe("vellum");
  });

  test("service process classifications are unchanged", () => {
    expect(classifyProcess("/opt/homebrew/bin/qdrant --config foo")).toBe(
      "qdrant",
    );
    expect(classifyProcess("bun /x/bin/vellum-gateway --port 7830")).toBe(
      "gateway",
    );
    expect(classifyProcess("bun /x/bin/vellum-daemon start")).toBe("assistant");
    expect(classifyProcess("node daemon start")).toBe("assistant");
    expect(
      classifyProcess("bun /x/bin/vellum-openclaw-adapter --port 9000"),
    ).toBe("openclaw-adapter");
  });

  test("macOS desktop app processes stay excluded", () => {
    expect(
      classifyProcess("/Applications/Vellum.app/Contents/MacOS/Vellum"),
    ).toBe("unknown");
  });

  test("repo paths containing vellum do not match", () => {
    expect(
      classifyProcess(
        "node /Users/runner/work/vellum-assistant/vellum-assistant/scripts/build.js",
      ),
    ).toBe("unknown");
  });
});

describe("detectOrphanedProcesses", () => {
  afterAll(() => {
    mock.module("./step-runner", () => realStepRunner);
  });

  test("skips live interactive sessions but still reports orphaned services", async () => {
    const psOutput = [
      "101 1 bun /Users/x/bin/vellum tunnel --provider ngrok",
      "102 1 vellum exec -it --service vellum-gateway -- /bin/sh",
      "103 1 vellum --plain logs foo",
      "104 1 bun /x/bin/vellum-gateway --port 7830",
      "105 1 vellum hatch",
      "106 1 node /opt/unrelated-service/daemon/main.ts",
      "107 1 node ./tools daemon start",
      "108 1 node /opt/VELLUM/daemon/main.ts",
    ].join("\n");
    mock.module("./step-runner", () => ({
      ...realStepRunner,
      execOutput: async () => psOutput,
    }));

    const orphans = await detectOrphanedProcesses({
      excludePids: new Set<string>(),
    });

    expect(orphans.map((o) => o.pid).sort()).toEqual(["104", "105"]);
    expect(orphans.find((o) => o.pid === "104")?.name).toBe("gateway");
    expect(orphans.find((o) => o.pid === "105")?.name).toBe("vellum");
  });
});
