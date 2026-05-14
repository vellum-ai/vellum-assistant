import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, ProfileSchema } from "../profile";

let tmp: string;
let originalDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "evals-profile-test-"));
  originalDir = process.env.EVALS_PROFILES_DIR;
  process.env.EVALS_PROFILES_DIR = tmp;
});

afterEach(() => {
  if (originalDir === undefined) {
    delete process.env.EVALS_PROFILES_DIR;
  } else {
    process.env.EVALS_PROFILES_DIR = originalDir;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, body: unknown): void {
  writeFileSync(join(tmp, `${name}.json`), JSON.stringify(body));
}

describe("ProfileSchema", () => {
  test("accepts a minimal bare-vellum profile", () => {
    const result = ProfileSchema.safeParse({
      id: "vellum-bare",
      species: "vellum",
      plugins: {},
      initial_state: {},
    });
    expect(result.success).toBe(true);
  });

  test("accepts plugins with arbitrary nested config", () => {
    const result = ProfileSchema.safeParse({
      id: "vellum-with-simple-memory",
      species: "vellum",
      plugins: {
        "simple-memory": { someFutureConfigKey: "value", nested: { a: 1 } },
      },
      initial_state: {},
    });
    expect(result.success).toBe(true);
  });

  test("accepts initial_state as filename → contents map", () => {
    const result = ProfileSchema.safeParse({
      id: "vellum-with-files",
      species: "vellum",
      plugins: {},
      initial_state: {
        "notes/intro.md": "# hello",
        "config.json": '{"key":"value"}',
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts version field on non-vellum species", () => {
    const result = ProfileSchema.safeParse({
      id: "openclaw-bare",
      species: "openclaw",
      version: "0.8.1",
      plugins: {},
      initial_state: {},
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty id", () => {
    const result = ProfileSchema.safeParse({
      id: "",
      species: "vellum",
      plugins: {},
      initial_state: {},
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown species", () => {
    const result = ProfileSchema.safeParse({
      id: "x",
      species: "made-up-species",
      plugins: {},
      initial_state: {},
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing plugins field", () => {
    const result = ProfileSchema.safeParse({
      id: "x",
      species: "vellum",
      initial_state: {},
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-string initial_state values", () => {
    const result = ProfileSchema.safeParse({
      id: "x",
      species: "vellum",
      plugins: {},
      initial_state: { "config.json": { not: "a string" } },
    });
    expect(result.success).toBe(false);
  });
});

describe("loadProfile", () => {
  test("loads a well-formed profile file", async () => {
    write("vellum-bare", {
      id: "vellum-bare",
      species: "vellum",
      plugins: {},
      initial_state: {},
    });
    const p = await loadProfile("vellum-bare");
    expect(p.id).toBe("vellum-bare");
    expect(p.species).toBe("vellum");
  });

  test("throws helpful error when file does not exist", async () => {
    await expect(loadProfile("missing")).rejects.toThrow(/not found/);
  });

  test("throws helpful error when JSON is malformed", async () => {
    writeFileSync(join(tmp, "broken.json"), "{ not valid json");
    await expect(loadProfile("broken")).rejects.toThrow(/not valid JSON/);
  });

  test("throws helpful error when schema fails", async () => {
    write("bad", { id: "bad", species: "vellum" }); // missing plugins/initial_state
    await expect(loadProfile("bad")).rejects.toThrow(/schema validation/);
  });

  test("throws when file id mismatches requested id", async () => {
    write("requested-id", {
      id: "actual-id-in-file",
      species: "vellum",
      plugins: {},
      initial_state: {},
    });
    await expect(loadProfile("requested-id")).rejects.toThrow(/id mismatch/);
  });
});
