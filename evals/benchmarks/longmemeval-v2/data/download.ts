/**
 * Fetch the LongMemEval-V2 dataset from Hugging Face and relabel question
 * IDs to human-readable keys defined in `question-labels.json`.
 *
 * The dataset is ~7.12 GB and stays gitignored. This script is idempotent:
 * huggingface-cli skips already-downloaded files (compares by hash), and
 * the relabel step is a pure transform that overwrites in place.
 *
 * Usage:
 *   bun run data/download.ts                  # download + relabel
 *   bun run data/download.ts --no-download    # relabel only (data already present)
 *   DATA_ROOT=/path bun run data/download.ts  # custom output dir
 *
 * Requires: huggingface-cli (`pip install -U "huggingface_hub[cli]"`).
 */
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const DATA_ROOT = resolve(process.env.DATA_ROOT ?? SCRIPT_DIR);
const REPO = process.env.REPO ?? "xiaowu0162/longmemeval-v2";
const NO_DOWNLOAD = process.argv.includes("--no-download");

async function existsFile(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!NO_DOWNLOAD) {
    await downloadDataset();
  }

  await relabelQuestions();
  console.log("\nDone. Top-level files:");
  const entries = await readdir(DATA_ROOT);
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    console.log(`  ${name}`);
  }

  console.log(`
The loader (src/loader.ts) reads:
  - questions.jsonl (relabeled with human-readable IDs)
  - haystacks/lme_v2_{small,medium}.json (re-keyed to match)

trajectories.jsonl and *_screenshots/ are consumed by the runner, not the loader.
`);
}

/**
 * Download the raw dataset from Hugging Face. Idempotent — skips files
 * that are already present and match the remote hash.
 */
async function downloadDataset(): Promise<void> {
  const proc = Bun.spawn({
    cmd: [
      "huggingface-cli",
      "download",
      REPO,
      "--repo-type",
      "dataset",
      "--local-dir",
      DATA_ROOT,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(
      `huggingface-cli exited with ${exitCode}. Install it with:\n  pip install -U "huggingface_hub[cli]"`,
    );
    process.exit(1);
  }
}

/**
 * Relabel question IDs in questions.jsonl and re-key both haystack files
 * using the mapping in question-labels.json. Overwrites the raw downloaded
 * files in place — the original hex IDs are preserved as a field in each
 * question record so the mapping is always recoverable.
 */
async function relabelQuestions(): Promise<void> {
  const labelsPath = join(DATA_ROOT, "question-labels.json");
  if (!(await existsFile(labelsPath))) {
    console.error(`question-labels.json not found at ${labelsPath}`);
    process.exit(1);
  }

  const labels: Record<string, string> = JSON.parse(
    await readFile(labelsPath, "utf8"),
  );
  console.log(`Loaded ${Object.keys(labels).length} human-readable labels`);

  // --- Relabel questions.jsonl ---
  const questionsPath = join(DATA_ROOT, "questions.jsonl");
  if (!(await existsFile(questionsPath))) {
    console.error(`questions.jsonl not found at ${questionsPath}`);
    process.exit(1);
  }

  const questionsRaw = await readFile(questionsPath, "utf8");
  const lines = questionsRaw.split("\n").filter((l) => l.trim() !== "");
  let relabeled = 0;
  let missing = 0;

  const outLines = lines.map((line) => {
    const q = JSON.parse(line) as Record<string, unknown>;
    const oldId = q.id as string;
    const newId = labels[oldId];
    if (!newId) {
      missing++;
      return line;
    }
    // Preserve the original ID as a field for traceability.
    q.originalId = oldId;
    q.id = newId;
    relabeled++;
    return JSON.stringify(q);
  });

  await writeFile(questionsPath, outLines.join("\n") + "\n");
  console.log(`Relabeled ${relabeled} questions (${missing} without a label)`);

  // --- Re-key haystack files ---
  for (const tier of ["small", "medium"] as const) {
    const haystackPath = join(DATA_ROOT, "haystacks", `lme_v2_${tier}.json`);
    if (!(await existsFile(haystackPath))) {
      console.log(`Skipping ${tier} haystack (not present)`);
      continue;
    }

    const haystack: Record<string, string[]> = JSON.parse(
      await readFile(haystackPath, "utf8"),
    );
    const rekeyed: Record<string, string[]> = {};
    let rekeyedCount = 0;

    for (const [oldId, trajIds] of Object.entries(haystack)) {
      const newId = labels[oldId];
      if (newId) {
        rekeyed[newId] = trajIds;
        rekeyedCount++;
      } else {
        // Keep unmapped entries under their original ID.
        rekeyed[oldId] = trajIds;
      }
    }

    await writeFile(haystackPath, JSON.stringify(rekeyed, null, 2) + "\n");
    console.log(`Re-keyed ${rekeyedCount} ${tier} haystack entries`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
