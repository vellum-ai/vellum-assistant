import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type {
  CommandResult,
  CommandRunner,
  RunOptions,
  SpawnedProcess,
} from "../../runtime/command-runner";
import {
  BrowserSession,
  browserSessionContainerName,
} from "../browser-session";

interface RunCall {
  command: string;
  args: string[];
  opts?: RunOptions;
}

const CDP_ENDPOINT_FILE = "/state/cdp-endpoint";

/**
 * Docker-free CommandRunner: records every invocation, answers the
 * readiness probe (`cat /state/cdp-endpoint`) and the per-action driver
 * exec from configurable state, and treats every other docker command as a
 * no-op success. Keeps BrowserSession unit tests off real Docker per the
 * harness's "policy testable without requiring Docker" convention.
 */
class FakeBrowserRunner implements CommandRunner {
  readonly runs: RunCall[] = [];
  /** Readiness polls that report "not ready" before the endpoint appears. */
  readyAfterPolls = 0;
  /** Canned driver result by action; defaults to `{ ok: true }`. */
  driverResult: (action: Record<string, unknown>) => CommandResult = () => ({
    exitCode: 0,
    stdout: JSON.stringify({ ok: true }) + "\n",
    stderr: "",
  });

  private polls = 0;

  async run(
    command: string,
    args: string[],
    opts?: RunOptions,
  ): Promise<CommandResult> {
    this.runs.push({ command, args, opts });
    if (command === "docker" && args[0] === "exec") {
      if (args.includes("cat") && args.at(-1) === CDP_ENDPOINT_FILE) {
        if (this.polls < this.readyAfterPolls) {
          this.polls++;
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "http://127.0.0.1:9222\n", stderr: "" };
      }
      if (args.includes("node")) {
        const action = JSON.parse(opts?.stdin ?? "{}") as Record<
          string,
          unknown
        >;
        return this.driverResult(action);
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  spawn(): SpawnedProcess {
    throw new Error("BrowserSession never spawns; it only runs docker");
  }
}

const baseOptions = {
  runId: "eval-browser-1",
  netnsContainer: "eval-browser-1-egress-jail",
  stateDir: "/runs/eval-browser-1/browser",
  sleep: async () => {},
};

const CONTAINER = "eval-browser-1-browser";

function dockerRuns(runner: FakeBrowserRunner): RunCall[] {
  return runner.runs.filter((r) => r.command === "docker");
}

function readinessPolls(runner: FakeBrowserRunner): RunCall[] {
  return runner.runs.filter(
    (r) => r.args.includes("cat") && r.args.at(-1) === CDP_ENDPOINT_FILE,
  );
}

describe("browserSessionContainerName", () => {
  test("derives the browser container name from the run id", () => {
    // GIVEN a run id
    // WHEN the container name is derived
    const name = browserSessionContainerName("eval-browser-1");

    // THEN it suffixes the run id with `-browser`.
    expect(name).toBe("eval-browser-1-browser");
  });
});

describe("BrowserSession.launch", () => {
  test("builds the image and starts the browser in the jail's namespace", async () => {
    // GIVEN a fake runner whose CDP endpoint is ready on the first poll
    const runner = new FakeBrowserRunner();

    // WHEN a session launches
    await BrowserSession.launch(runner, baseOptions);

    // THEN it pre-removes any stale container before building the image,
    const docker = dockerRuns(runner);
    expect(docker[0].args).toEqual(["rm", "-f", CONTAINER]);
    expect(docker[1].args.slice(0, 3)).toEqual([
      "build",
      "-t",
      "vellum-evals-browser:local",
    ]);

    // AND runs it detached, attached to the jail netns, with /state mounted.
    const runCall = docker.find((r) => r.args[0] === "run");
    expect(runCall).toBeDefined();
    expect(runCall!.args).toContain("-d");
    expect(runCall!.args).toContain("--name");
    expect(runCall!.args).toContain(CONTAINER);
    expect(runCall!.args).toContain("--network");
    expect(runCall!.args).toContain("container:eval-browser-1-egress-jail");
    expect(runCall!.args).toContain("-v");
    expect(runCall!.args).toContain("/runs/eval-browser-1/browser:/state");

    // AND it waits for the CDP endpoint to appear.
    expect(readinessPolls(runner).length).toBe(1);
  });

  test("polls the CDP endpoint until it appears", async () => {
    // GIVEN a runner that reports not-ready for two polls
    const runner = new FakeBrowserRunner();
    runner.readyAfterPolls = 2;
    const sleeps: number[] = [];

    // WHEN a session launches
    await BrowserSession.launch(runner, {
      ...baseOptions,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    // THEN it polls three times and sleeps between the failed polls.
    expect(readinessPolls(runner).length).toBe(3);
    expect(sleeps).toEqual([100, 100]);
  });

  test("clears the stale CDP endpoint file before starting the container", async () => {
    // GIVEN a fake runner whose CDP endpoint is ready on the first poll
    const runner = new FakeBrowserRunner();
    const staleEndpoint = "/runs/eval-browser-1/browser/cdp-endpoint";

    // WHEN a session launches
    await BrowserSession.launch(runner, baseOptions);

    // THEN it removes a prior boot's endpoint file from the state dir,
    const clear = runner.runs.find(
      (r) => r.command === "rm" && r.args.at(-1) === staleEndpoint,
    );
    expect(clear).toBeDefined();
    expect(clear!.args).toEqual(["-f", staleEndpoint]);

    // AND does so before running the container, so readiness can't pass
    // against the stale file.
    const runIndex = runner.runs.findIndex(
      (r) => r.command === "docker" && r.args[0] === "run",
    );
    expect(runner.runs.indexOf(clear!)).toBeLessThan(runIndex);
  });

  test("fails when the CDP endpoint never appears", async () => {
    // GIVEN a runner whose CDP endpoint never becomes ready
    const runner = new FakeBrowserRunner();
    runner.readyAfterPolls = Number.POSITIVE_INFINITY;

    // WHEN a session launches with a small readiness budget
    const launch = BrowserSession.launch(runner, {
      ...baseOptions,
      readyMaxAttempts: 3,
    });

    // THEN it rejects after exhausting the budget.
    await expect(launch).rejects.toThrow("did not become ready");
  });

  test("force-removes the container when readiness fails", async () => {
    // GIVEN a runner whose CDP endpoint never becomes ready
    const runner = new FakeBrowserRunner();
    runner.readyAfterPolls = Number.POSITIVE_INFINITY;

    // WHEN a session launches with a small readiness budget and fails
    await expect(
      BrowserSession.launch(runner, { ...baseOptions, readyMaxAttempts: 2 }),
    ).rejects.toThrow("did not become ready");

    // THEN it force-removes the started container after the failed run, so a
    // container can't leak and outlive the jail it shares a namespace with.
    const runIndex = runner.runs.findIndex(
      (r) => r.command === "docker" && r.args[0] === "run",
    );
    const cleanup = runner.runs
      .slice(runIndex + 1)
      .find(
        (r) =>
          r.command === "docker" &&
          r.args[0] === "rm" &&
          r.args.at(-1) === CONTAINER,
      );
    expect(cleanup).toBeDefined();
  });
});

describe("BrowserSession actions", () => {
  test("load pipes a load action to the driver over docker exec stdin", async () => {
    // GIVEN a launched session
    const runner = new FakeBrowserRunner();
    const session = await BrowserSession.launch(runner, baseOptions);
    const baseline = runner.runs.length;

    // WHEN the caller loads a self-contained page
    await session.load("<html><body>hi</body></html>");

    // THEN it execs the driver with `-i` and pipes a load action on stdin.
    const call = runner.runs[baseline];
    expect(call.args).toEqual([
      "exec",
      "-i",
      CONTAINER,
      "node",
      "/opt/browser/driver.mjs",
    ]);
    expect(JSON.parse(call.opts!.stdin!)).toEqual({
      kind: "load",
      html: "<html><body>hi</body></html>",
    });
  });

  test("observe parses the driver's url, snapshot, and console errors", async () => {
    // GIVEN a launched session whose driver returns an observation
    const runner = new FakeBrowserRunner();
    runner.driverResult = (action) =>
      action.kind === "observe"
        ? {
            exitCode: 0,
            stdout:
              JSON.stringify({
                url: "about:blank",
                snapshot: '- button "7"',
                consoleErrors: ["boom"],
              }) + "\n",
            stderr: "",
          }
        : {
            exitCode: 0,
            stdout: JSON.stringify({ ok: true }) + "\n",
            stderr: "",
          };
    const session = await BrowserSession.launch(runner, baseOptions);

    // WHEN the caller observes the page
    const observation = await session.observe();

    // THEN it returns the parsed observation.
    expect(observation).toEqual({
      url: "about:blank",
      snapshot: '- button "7"',
      consoleErrors: ["boom"],
    });
  });

  test("act forwards a click's role, name, and nth to the driver", async () => {
    // GIVEN a launched session
    const runner = new FakeBrowserRunner();
    const session = await BrowserSession.launch(runner, baseOptions);
    const baseline = runner.runs.length;

    // WHEN the caller clicks the second "7" button
    await session.act({ kind: "click", role: "button", name: "7", nth: 1 });

    // THEN the action JSON is piped to the driver verbatim.
    expect(JSON.parse(runner.runs[baseline].opts!.stdin!)).toEqual({
      kind: "click",
      role: "button",
      name: "7",
      nth: 1,
    });
  });

  test("screenshot writes under the state mount and returns the host path", async () => {
    // GIVEN a launched session
    const runner = new FakeBrowserRunner();
    const session = await BrowserSession.launch(runner, baseOptions);
    const baseline = runner.runs.length;

    // WHEN the caller captures a screenshot
    const path = await session.screenshot("step-1.png");

    // THEN the driver writes to /state/<name> and the host path is returned.
    expect(JSON.parse(runner.runs[baseline].opts!.stdin!)).toEqual({
      kind: "screenshot",
      path: "/state/step-1.png",
    });
    expect(path).toBe(join("/runs/eval-browser-1/browser", "step-1.png"));
  });

  test("screenshot rejects a name that escapes the state mount", async () => {
    // GIVEN a launched session
    const runner = new FakeBrowserRunner();
    const session = await BrowserSession.launch(runner, baseOptions);

    // WHEN the caller passes a name with a path separator
    // THEN it rejects before touching the driver.
    await expect(session.screenshot("../escape.png")).rejects.toThrow(
      "bare filename",
    );
  });

  test("rejects with the driver's message when an action errors", async () => {
    // GIVEN a launched session whose driver returns an error result
    const runner = new FakeBrowserRunner();
    const session = await BrowserSession.launch(runner, baseOptions);
    runner.driverResult = () => ({
      exitCode: 0,
      stdout: JSON.stringify({ error: "unknown action kind: nope" }) + "\n",
      stderr: "",
    });

    // WHEN an action's driver result carries an error
    // THEN the action rejects with the driver's message.
    await expect(session.act({ kind: "press", key: "Enter" })).rejects.toThrow(
      "unknown action kind: nope",
    );
  });

  test("close force-removes the browser container", async () => {
    // GIVEN a launched session
    const runner = new FakeBrowserRunner();
    const session = await BrowserSession.launch(runner, baseOptions);
    const baseline = runner.runs.length;

    // WHEN the session is closed
    await session.close();

    // THEN it force-removes the container.
    expect(runner.runs[baseline].args).toEqual(["rm", "-f", CONTAINER]);
  });
});
