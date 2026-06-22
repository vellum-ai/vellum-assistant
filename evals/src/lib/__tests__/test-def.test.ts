import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTestDef } from "../test-def";

async function makeUnit(
  spec: string,
): Promise<{ unitsDir: string; id: string }> {
  const unitsDir = await mkdtemp(join(tmpdir(), "evals-test-def-"));
  const id = "unit-a";
  await mkdir(join(unitsDir, id), { recursive: true });
  await writeFile(join(unitsDir, id, "SPEC.md"), spec, "utf8");
  return { unitsDir, id };
}

describe("loadTestDef SPEC.md frontmatter status", () => {
  test("parses status from YAML frontmatter", async () => {
    // GIVEN a test unit whose SPEC.md declares `status: experimental` in
    // YAML frontmatter
    const { unitsDir, id } = await makeUnit(
      "---\nstatus: experimental\n---\n\n# unit-a\n",
    );

    // WHEN the test definition is loaded
    const def = await loadTestDef(id, unitsDir);

    // THEN the parsed status is exposed on the definition
    expect(def.status).toBe("experimental");
  });

  test("leaves status undefined when SPEC.md has no frontmatter", async () => {
    // GIVEN a test unit whose SPEC.md is plain markdown with no frontmatter
    const { unitsDir, id } = await makeUnit(
      "# unit-a\n\nNo frontmatter here.\n",
    );

    // WHEN the test definition is loaded
    const def = await loadTestDef(id, unitsDir);

    // THEN no status is reported
    expect(def.status).toBeUndefined();
  });

  test("leaves status undefined when frontmatter lacks a status key", async () => {
    // GIVEN a test unit whose frontmatter declares other keys but no status
    const { unitsDir, id } = await makeUnit(
      "---\nowner: evals\n---\n\n# unit-a\n",
    );

    // WHEN the test definition is loaded
    const def = await loadTestDef(id, unitsDir);

    // THEN no status is reported
    expect(def.status).toBeUndefined();
  });
});
