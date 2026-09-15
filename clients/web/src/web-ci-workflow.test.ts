import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { load } from "js-yaml";

type WorkflowJob = {
  name: string;
  needs?: string[];
  if?: string;
  steps: {
    name: string;
    env?: Record<string, string>;
    run?: string;
  }[];
};

const workflow = load(
  await Bun.file(
    new URL("../../../.github/workflows/pr-web.yaml", import.meta.url),
  ).text(),
) as { jobs: Record<string, WorkflowJob> };
const checks = workflow.jobs.checks;
const jobs = Object.keys(workflow.jobs).filter((job) => job !== "checks");
const aggregate = checks.steps.find(
  (step) => step.name === "Aggregate results",
);
if (!aggregate?.run || !aggregate.env) {
  throw new Error(
    "Web CI must provide an aggregate result script and job results",
  );
}
const script = aggregate.run;
const resultVariables = Object.entries(aggregate.env).map(
  ([name, expression]) => {
    const match = /^\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}$/.exec(expression);
    if (!match) {
      throw new Error(`Unsupported job result expression: ${expression}`);
    }
    return [name, match[1]] as const;
  },
);

function runAggregate(results: Record<string, string> = {}): number | null {
  const env = Object.fromEntries(
    resultVariables.map(([name, job]) => [name, results[job] ?? "success"]),
  );
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", script],
    {
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  expect(result.error).toBeUndefined();
  return result.status;
}

describe("web CI merge gate", () => {
  test("waits for every check and evaluates unsuccessful dependencies", () => {
    expect(checks.name).toBe("Lint, Type Check & Build");
    expect(checks.if).toBe("always()");
    expect(checks.needs?.toSorted()).toEqual(jobs.toSorted());
    expect(resultVariables.map(([, job]) => job).toSorted()).toEqual(
      jobs.toSorted(),
    );
  });

  test("passes when every check succeeds", () => {
    expect(runAggregate()).toBe(0);
  });

  for (const job of jobs) {
    test.each(["failure", "cancelled", "skipped"])(
      `fails when ${job} reports %s`,
      (result) => {
        expect(runAggregate({ [job]: result })).toBe(1);
      },
    );
  }
});
