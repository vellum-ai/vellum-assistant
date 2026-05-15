import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { listProfileIds, listTestIds } from "../catalog";
import { loadProfile } from "../profile";
import { loadTestDef } from "../test-def";

const originalProfilesDir = process.env.EVALS_PROFILES_DIR;
const originalTestsDir = process.env.EVALS_TESTS_DIR;

afterEach(() => {
  if (originalProfilesDir === undefined) delete process.env.EVALS_PROFILES_DIR;
  else process.env.EVALS_PROFILES_DIR = originalProfilesDir;
  if (originalTestsDir === undefined) delete process.env.EVALS_TESTS_DIR;
  else process.env.EVALS_TESTS_DIR = originalTestsDir;
});

describe("eval catalog discovery", () => {
  test("lists profile directories alphabetically and validates manifests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-profiles-"));
    process.env.EVALS_PROFILES_DIR = dir;

    await mkdir(join(dir, "zeta"), { recursive: true });
    await mkdir(join(dir, "alpha"), { recursive: true });
    await mkdir(join(dir, ".ignored"), { recursive: true });
    await writeFile(
      join(dir, "zeta", "manifest.json"),
      JSON.stringify({ species: "vellum" }),
      "utf8",
    );
    await writeFile(
      join(dir, "alpha", "manifest.json"),
      JSON.stringify({ species: "codex" }),
      "utf8",
    );

    expect(await listProfileIds()).toEqual(["alpha", "zeta"]);
    await expect(loadProfile("alpha")).resolves.toMatchObject({
      id: "alpha",
      manifest: { species: "codex" },
    });
  });

  test("rejects unsafe catalog ids discovered on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-profiles-"));
    process.env.EVALS_PROFILES_DIR = dir;
    await mkdir(join(dir, "bad_id"), { recursive: true });

    await expect(listProfileIds()).rejects.toThrow("Invalid profile id");
  });

  test("lists tests and loads setup plus metric files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-tests-"));
    process.env.EVALS_TESTS_DIR = dir;
    await mkdir(join(dir, "timeline-recall", "metrics"), { recursive: true });
    await writeFile(join(dir, "timeline-recall", "SPEC.md"), "# spec", "utf8");
    await writeFile(
      join(dir, "timeline-recall", "setup.ts"),
      'export default [{ type: "seed-conversation", messages: [] }];',
      "utf8",
    );
    await writeFile(
      join(dir, "timeline-recall", "metrics", "score.ts"),
      "export default async () => ({ name: 'score', score: 1 });",
      "utf8",
    );

    expect(await listTestIds()).toEqual(["timeline-recall"]);
    await expect(loadTestDef("timeline-recall")).resolves.toMatchObject({
      id: "timeline-recall",
      setupCommands: [{ type: "seed-conversation", messages: [] }],
      metricPaths: [join(dir, "timeline-recall", "metrics", "score.ts")],
    });
  });
});
