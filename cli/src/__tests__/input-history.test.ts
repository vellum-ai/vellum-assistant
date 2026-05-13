import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { getInputHistoryPath } from "../lib/environments/paths.js";
import { appendHistory, loadHistory } from "../lib/input-history.js";

describe("input-history XDG paths", () => {
  let tempDir: string;
  let savedState: string | undefined;

  beforeEach(() => {
    savedState = process.env.XDG_STATE_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "cli-input-history-test-"));
    process.env.XDG_STATE_HOME = join(tempDir, ".local", "state");
  });

  afterEach(() => {
    if (savedState === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = savedState;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("appendHistory writes to $XDG_STATE_HOME/vellum/input-history", () => {
    appendHistory("hello world");

    const canonical = getInputHistoryPath();
    expect(canonical).toBe(
      join(tempDir, ".local", "state", "vellum", "input-history"),
    );
    expect(existsSync(canonical)).toBe(true);
    expect(readFileSync(canonical, "utf-8")).toBe("hello world\n");
  });

  test("appendHistory does NOT touch ~/.vellum/", () => {
    // Crucially: the CLI must not create or write to ~/.vellum/ per the
    // "No `.vellum/` directory access" boundary in cli/AGENTS.md. We snapshot
    // the legacy path's existence before the call (some test machines already
    // have a ~/.vellum/ for unrelated daemon state) and assert the file at
    // that path is unchanged afterwards.
    const legacyPath = join(homedir(), ".vellum", "input-history");
    const existedBefore = existsSync(legacyPath);
    const contentBefore: string = existedBefore
      ? readFileSync(legacyPath, "utf-8")
      : "";

    appendHistory("hello");

    expect(existsSync(legacyPath)).toBe(existedBefore);
    if (existedBefore) {
      expect(readFileSync(legacyPath, "utf-8")).toBe(contentBefore);
    }
  });

  test("XDG_STATE_HOME default is ~/.local/state when unset", () => {
    delete process.env.XDG_STATE_HOME;

    // os.homedir() is cached at process start by Bun and ignores
    // process.env.HOME mutations, so compute the expected path from the same
    // source the production helper uses.
    expect(getInputHistoryPath()).toBe(
      join(homedir(), ".local", "state", "vellum", "input-history"),
    );
  });

  test("appendHistory skips empty and slash-command entries", () => {
    appendHistory("");
    appendHistory("   ");
    appendHistory("/help");
    appendHistory("real entry");

    expect(loadHistory()).toEqual(["real entry"]);
  });

  test("appendHistory deduplicates by moving to most recent", () => {
    appendHistory("a");
    appendHistory("b");
    appendHistory("a");

    expect(loadHistory()).toEqual(["b", "a"]);
  });

  test("appendHistory caps history at MAX_ENTRIES (1000)", () => {
    for (let i = 0; i < 1100; i++) {
      appendHistory(`entry-${i}`);
    }

    const history = loadHistory();
    expect(history.length).toBe(1000);
    expect(history[0]).toBe("entry-100");
    expect(history[999]).toBe("entry-1099");
  });
});
