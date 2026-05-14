/**
 * `evals run` — Cartesian profile × test runner.
 *
 * v0.1 PR-1 (this commit): dry-run. Validates --profiles and --tests args,
 * loads each profile and test definition against its Zod schema, and prints
 * what would be executed. No agent process is spawned, no simulator runs,
 * no JSONL row is emitted.
 *
 * Execution ships incrementally:
 *   - PR-2: Vellum adapter + Docker-network egress jail
 *   - PR-3: Haiku-backed simulator + Test 1 scorer + JSONL emission
 *   - PR-4: Static HTML report
 */
import { parseArgs } from "node:util";
import { loadProfile } from "../lib/profile";
import { loadTestDef } from "../lib/test-def";

const HELP = `
🚀 evals run — Run profile × test combinations

Usage:
  evals run --profiles <id1>[,<id2>...] --tests <id1>[,<id2>...]

Options:
  --profiles <ids>    Comma-separated profile IDs. Each must match a file at
                      profiles/<id>.json under the evals package root.
  --tests <ids>       Comma-separated test definition IDs. Each must match a
                      file at tests/<id>.json under the evals package root.
  --help, -h          Show help

Examples:
  evals run --profiles vellum-bare --tests mem.single_turn.timeline_recall
  evals run --profiles vellum-bare,vellum-with-simple-memory \\
            --tests mem.single_turn.timeline_recall

State:
  v0.1 PR-1 — dry-run only. Loads schemas and prints what would run.
  Execution path ships in PR-2/PR-3/PR-4.
`.trim();

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function run(args: string[]): Promise<void> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        profiles: { type: "string" },
        tests: { type: "string" },
      },
      strict: true,
    });
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    console.error("");
    console.error(HELP);
    process.exit(1);
  }

  const { values } = parsed;

  if (!values.profiles) {
    console.error("❌ --profiles is required (comma-separated profile IDs)");
    process.exit(1);
  }
  if (!values.tests) {
    console.error(
      "❌ --tests is required (comma-separated test definition IDs)",
    );
    process.exit(1);
  }

  const profileIds = splitCsv(values.profiles);
  const testIds = splitCsv(values.tests);

  if (profileIds.length === 0) {
    console.error("❌ --profiles is empty after splitting on commas");
    process.exit(1);
  }
  if (testIds.length === 0) {
    console.error("❌ --tests is empty after splitting on commas");
    process.exit(1);
  }

  console.log(`📋 Profiles (${profileIds.length}): ${profileIds.join(", ")}`);
  console.log(`📋 Tests    (${testIds.length}): ${testIds.join(", ")}`);
  console.log("");

  // Load profiles
  const profiles = [];
  for (const id of profileIds) {
    const p = await loadProfile(id);
    const pluginCount = Object.keys(p.plugins).length;
    const pluginSummary =
      pluginCount === 0
        ? "no plugins"
        : `${pluginCount} plugin(s): ${Object.keys(p.plugins).join(", ")}`;
    console.log(
      `  ✓ profile "${p.id}" — species=${p.species}, ${pluginSummary}`,
    );
    profiles.push(p);
  }

  // Load tests
  const tests = [];
  for (const id of testIds) {
    const t = await loadTestDef(id);
    console.log(
      `  ✓ test    "${t.id}" — shape=${t.shape}, dims=[${t.dimensions.join("+")}]`,
    );
    tests.push(t);
  }

  console.log("");
  console.log(
    `🟦 Cartesian matrix: ${profiles.length} × ${tests.length} = ${profiles.length * tests.length} run(s) planned.`,
  );
  console.log("");
  console.log("⚠️  [DRY RUN] Execution path is not yet implemented.");
  console.log(
    "    PR-2 adds the Vellum agent adapter and Docker-network egress jail.",
  );
  console.log(
    "    PR-3 adds the simulator + first test scorer + JSONL emission.",
  );
  console.log("    PR-4 adds the static HTML report.");
}
