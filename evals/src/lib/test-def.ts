/**
 * Test definition — declarative unit of "what the harness runs against a profile."
 *
 * v0.1 PR-1 locks in only the identity / shape / dimensions / objective fields.
 * Fixture, simulator script, and scorer fields land in PR-3 when Test 1's
 * execution path ships; the schema uses .passthrough() so PR-3 can extend
 * test JSON without breaking PR-1 loaders.
 *
 * Test slug convention: `<domain>.<shape>.<name>` (e.g. `mem.single_turn.timeline_recall`).
 * The plan calls this an open taxonomy — `shape` is `z.string()` not an enum.
 */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TestDefSchema = z
  .object({
    /** Unique test identifier. Must match the filename: `tests/<id>.json`. */
    id: z.string().min(1),
    /**
     * Test shape. Starter values: single_turn, single_conv, multi_session,
     * background, mixed_tier. Open taxonomy — additional shapes are allowed.
     */
    shape: z.string().min(1),
    /**
     * Personal-intelligence dimensions this test exercises. Starter set in
     * plan: memory, judgment, initiative, follow-through, communication,
     * cross-context coherence, trust handling, life navigation. Open taxonomy.
     */
    dimensions: z.array(z.string().min(1)).min(1),
    /** Human-readable description of what the test does and what it checks. */
    objective: z.string().min(1),
  })
  .passthrough();

export type TestDef = z.infer<typeof TestDefSchema>;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TESTS_DIR = join(HERE, "..", "..", "tests");

function testsDir(): string {
  return process.env.EVALS_TESTS_DIR ?? DEFAULT_TESTS_DIR;
}

export async function loadTestDef(id: string): Promise<TestDef> {
  const path = join(testsDir(), `${id}.json`);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Test definition "${id}" not found at ${path}`);
    }
    throw new Error(
      `Failed to read test definition "${id}" at ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Test definition "${id}" at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }

  const result = TestDefSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Test definition "${id}" at ${path} failed schema validation:\n${issues}`,
    );
  }

  if (result.data.id !== id) {
    throw new Error(
      `Test definition id mismatch: file at ${path} declares id "${result.data.id}" but was loaded as "${id}"`,
    );
  }

  return result.data;
}
