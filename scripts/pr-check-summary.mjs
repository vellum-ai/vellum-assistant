#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const prRef = process.argv[2];

const prViewFieldSets = [
  ["state", "mergedAt", "title", "url", "headRefName", "baseRefName", "reviewDecision", "mergeStateStatus"],
  ["state", "mergedAt", "title", "url", "headRefName", "baseRefName", "reviewDecision"],
  ["state", "mergedAt", "title", "url", "headRefName", "baseRefName"],
];
const checkFields = [
  "name",
  "state",
  "link",
  "workflow",
  "startedAt",
  "completedAt",
  "description",
  "bucket",
  "event",
];

if (!prRef) {
  console.error("Usage: node scripts/pr-check-summary.mjs <pr-number-or-url>");
  process.exit(1);
}

function runGh(args) {
  return spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function resultMessage(result, fallback) {
  if (result.error) {
    return result.error.message;
  }

  return result.stderr?.trim() || result.stdout?.trim() || fallback;
}

function parseJson(stdout, context) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Could not parse ${context} JSON: ${error.message}`);
  }
}

function getPr() {
  const errors = [];

  for (const fields of prViewFieldSets) {
    const result = runGh(["pr", "view", prRef, "--json", fields.join(",")]);
    if (result.status === 0) {
      return parseJson(result.stdout, "PR");
    }

    errors.push(resultMessage(result, `gh pr view exited ${result.status}`));
  }

  throw new Error(`Could not inspect PR ${prRef}:\n${errors.join("\n")}`);
}

function getChecks() {
  const result = runGh(["pr", "checks", prRef, "--json", checkFields.join(",")]);
  if (result.status === 0) {
    const checks = parseJson(result.stdout, "checks");
    if (!Array.isArray(checks)) {
      throw new Error("Could not inspect checks: gh returned non-array JSON.");
    }
    return checks;
  }

  const message = resultMessage(result, `gh pr checks exited ${result.status}`);
  return { error: message };
}

function isFailed(check) {
  const values = [check.state, check.bucket].filter(Boolean).map((value) => String(value).toLowerCase());
  return values.some((value) => (
    value.includes("fail") ||
    value.includes("error") ||
    value.includes("cancel") ||
    value.includes("timed_out") ||
    value.includes("action_required")
  ));
}

function isPending(check) {
  const values = [check.state, check.bucket].filter(Boolean).map((value) => String(value).toLowerCase());
  return values.some((value) => (
    value.includes("pending") ||
    value.includes("queued") ||
    value.includes("in_progress") ||
    value.includes("running") ||
    value.includes("waiting") ||
    value.includes("requested")
  ));
}

function isPassing(check) {
  const values = [check.state, check.bucket].filter(Boolean).map((value) => String(value).toLowerCase());
  return values.some((value) => value.includes("pass") || value.includes("success"));
}

function isSkipped(check) {
  const values = [check.state, check.bucket].filter(Boolean).map((value) => String(value).toLowerCase());
  return values.some((value) => value.includes("skip"));
}

function formatCheck(check) {
  const parts = [check.name || "(unnamed check)"];
  if (check.workflow) {
    parts.push(`workflow: ${check.workflow}`);
  }
  if (check.state) {
    parts.push(`state: ${check.state}`);
  }
  if (check.bucket) {
    parts.push(`bucket: ${check.bucket}`);
  }
  if (check.link) {
    parts.push(`link: ${check.link}`);
  }
  if (check.description) {
    parts.push(`description: ${check.description}`);
  }
  return parts.join(" | ");
}

function printSection(label, lines) {
  console.log(`\n${label}`);
  if (lines.length === 0) {
    console.log("- None");
    return;
  }

  for (const line of lines) {
    console.log(`- ${line}`);
  }
}

function prLines(pr) {
  const lines = [
    `${pr.title ?? "(untitled)"}`,
    `${pr.url ?? prRef}`,
    `State: ${pr.state ?? "unknown"}${pr.mergedAt ? `, merged at ${pr.mergedAt}` : ""}`,
  ];

  if (pr.headRefName || pr.baseRefName) {
    lines.push(`Branch: ${pr.headRefName ?? "unknown"} -> ${pr.baseRefName ?? "unknown"}`);
  }
  if (pr.mergeStateStatus) {
    lines.push(`Merge state: ${pr.mergeStateStatus}`);
  }

  return lines;
}

function reviewLines(pr) {
  if (!pr.reviewDecision) {
    return ["Review decision unavailable or not required."];
  }

  return [`Review decision: ${pr.reviewDecision}`];
}

function checkSummary(checksResult) {
  if (checksResult.error) {
    return {
      lines: [`Could not inspect checks: ${checksResult.error}`],
      nextSteps: ["Open the PR in GitHub or rerun this helper after confirming gh authentication and repository access."],
    };
  }

  if (checksResult.length === 0) {
    return {
      lines: ["No checks reported for this PR."],
      nextSteps: ["No CI inspection target found."],
    };
  }

  const failed = checksResult.filter(isFailed);
  const pending = checksResult.filter((check) => !isFailed(check) && isPending(check));
  const passing = checksResult.filter((check) => !isFailed(check) && !isPending(check) && isPassing(check));
  const skipped = checksResult.filter((check) => !isFailed(check) && !isPending(check) && !isPassing(check) && isSkipped(check));
  const other = checksResult.filter((check) => (
    !failed.includes(check) &&
    !pending.includes(check) &&
    !passing.includes(check) &&
    !skipped.includes(check)
  ));

  const lines = [
    `${checksResult.length} total: ${passing.length} passing, ${failed.length} failing, ${pending.length} in progress or pending, ${skipped.length} skipped, ${other.length} other.`,
  ];

  for (const check of failed) {
    lines.push(`Failed: ${formatCheck(check)}`);
  }
  for (const check of pending) {
    lines.push(`Pending: ${formatCheck(check)}. Logs may not be available yet.`);
  }
  for (const check of other) {
    lines.push(`Other: ${formatCheck(check)}`);
  }
  if (failed.length === 0 && pending.length === 0 && skipped.length === 0 && other.length === 0) {
    lines.push("All reported checks are passing.");
  } else if (failed.length === 0 && pending.length === 0 && other.length === 0) {
    lines.push("No failed or running checks reported; skipped checks are not CI-log targets.");
  }

  const nextSteps = [];
  if (failed.length > 0) {
    nextSteps.push("Inspect failed check links above, then fetch logs for the specific run/job if needed.");
  }
  if (pending.length > 0) {
    nextSteps.push("Wait for pending checks to finish before trying to fetch logs; GitHub may not expose logs while a job is queued or running.");
  }
  if (failed.length === 0 && pending.length === 0) {
    nextSteps.push("No failed or running checks need CI-log inspection.");
  }

  return { lines, nextSteps };
}

try {
  const pr = getPr();
  const checksResult = getChecks();
  const checks = checkSummary(checksResult);

  printSection("PR", prLines(pr));
  printSection("Checks", checks.lines);
  printSection("Review", reviewLines(pr));
  printSection("Next steps", checks.nextSteps);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
