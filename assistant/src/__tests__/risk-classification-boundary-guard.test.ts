import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

/**
 * Guard test: risk classification is gateway-owned. The assistant is a client
 * of the gateway's `classify_risk` method and nothing more (see
 * `src/permissions/AGENTS.md` and `gateway/src/risk/AGENTS.md`).
 *
 * Two things this pins, because both have regrown before:
 *
 * 1. Exactly one production call site of `ipcClassifyRisk`, in
 *    `permissions/checker.ts` (`classifyRisk`). A second caller is a second
 *    classification per invocation, or a memo, in the making.
 * 2. No production module under `assistant/src` classifies locally: no
 *    tree-sitter, no `RiskClassifier`, no risk registry. If a tool's risk is
 *    wrong, the fix is in `gateway/src/risk/`.
 */

const ASSISTANT_SRC = "assistant/src";

/** The one production caller of the gateway classification method. */
const CLASSIFY_RISK_CALLER = "assistant/src/permissions/checker.ts";
/** Where `ipcClassifyRisk` is defined (a definition, not a call site). */
const CLASSIFY_RISK_CLIENT = "assistant/src/ipc/gateway-client.ts";

function isTestFile(path: string): boolean {
  return (
    path.includes("/__tests__/") ||
    path.endsWith(".test.ts") ||
    path.endsWith(".benchmark.test.ts")
  );
}

/** `git grep -E` over assistant/src production TypeScript, one entry per match. */
function gitGrepProduction(pattern: string, ...flags: string[]): string[] {
  const result = spawnSync(
    "git",
    ["grep", "-E", ...flags, pattern, "--", `${ASSISTANT_SRC}/*.ts`],
    { encoding: "utf-8", cwd: process.cwd() + "/.." },
  );
  // Exit code 1 is "no matches"; anything else is a real failure.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git grep failed: ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .filter((line) => !isTestFile(line.split(":")[0]));
}

/** Files with at least one match. */
function productionFilesMatching(pattern: string): string[] {
  return gitGrepProduction(pattern, "-l");
}

/** Every matching line as `file:line:text`. */
function productionLinesMatching(pattern: string): string[] {
  return gitGrepProduction(pattern, "-n");
}

describe("risk classification boundary guard", () => {
  test("the classify_risk method is spoken only by the IPC client", () => {
    // A direct `"classify_risk"` call would bypass the client's contract
    // validation and retry policy.
    const files = productionFilesMatching('"classify_risk"');
    expect(files, `Found: ${files.join(", ")}`).toEqual([CLASSIFY_RISK_CLIENT]);
  });

  test("ipcClassifyRisk has exactly one production call site", () => {
    // Per line, not per file: a second call inside checker.ts is the case
    // this exists to catch.
    const calls = productionLinesMatching("ipcClassifyRisk\\(").filter(
      (line) => !line.startsWith(`${CLASSIFY_RISK_CLIENT}:`),
    );
    expect(
      calls,
      [
        "The gateway classifier must be called from exactly one place,",
        `${CLASSIFY_RISK_CALLER} (classifyRisk). Calls found:`,
        ...calls.map((c) => `  - ${c}`),
        "",
        "Thread the invocation's RiskClassificationWithMeta from classifyRisk",
        "instead of classifying again.",
      ].join("\n"),
    ).toHaveLength(1);
    expect(calls[0]).toStartWith(`${CLASSIFY_RISK_CALLER}:`);
    expect(calls[0]).toContain("await ipcClassifyRisk(");
  });

  test("no production module under assistant/src classifies risk locally", () => {
    const patterns = [
      // Shell parsing belongs to the gateway.
      "from ['\"](web-)?tree-sitter",
      // A local classifier class or interface.
      "(class|interface) [A-Za-z]*RiskClassifier\\b",
      "implements RiskClassifier\\b",
      // A local command risk registry.
      "DEFAULT_COMMAND_REGISTRY\\b",
    ];
    const violations = patterns.flatMap((p) =>
      productionFilesMatching(p).map((f) => `${f} (${p})`),
    );
    expect(
      violations,
      [
        "Risk classification is gateway-owned; nothing under assistant/src may",
        "classify locally. Found:",
        ...violations.map((v) => `  - ${v}`),
        "",
        "Move the classifier into gateway/src/risk/ and read the answer from",
        "classifyRisk().",
      ].join("\n"),
    ).toEqual([]);
  });
});
