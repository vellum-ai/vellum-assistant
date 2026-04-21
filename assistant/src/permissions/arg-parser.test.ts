import { describe, expect, test } from "bun:test";

import { parseArgs } from "./arg-parser.js";

describe("parseArgs", () => {
  test("boolean flags", () => {
    const result = parseArgs(["-v", "-f"], {});
    expect(result.flags.get("-v")).toBe(true);
    expect(result.flags.get("-f")).toBe(true);
    expect(result.positionals).toEqual([]);
    expect(result.pathArgs).toEqual([]);
    expect(result.sawDoubleDash).toBe(false);
  });

  test("value-consuming flags", () => {
    const result = parseArgs(["-o", "out.txt", "in.txt"], {
      valueFlags: ["-o"],
    });
    expect(result.flags.get("-o")).toBe("out.txt");
    expect(result.positionals).toEqual(["in.txt"]);
    // Default positionals mode is "paths", so in.txt is a path.
    expect(result.pathArgs).toEqual(["in.txt"]);
  });

  test("path flags", () => {
    const result = parseArgs(["-t", "/tmp/dir", "file.txt"], {
      valueFlags: ["-t"],
      pathFlags: { "-t": true },
    });
    expect(result.flags.get("-t")).toBe("/tmp/dir");
    expect(result.positionals).toEqual(["file.txt"]);
    // /tmp/dir from pathFlag + file.txt from default positional "paths" mode.
    expect(result.pathArgs).toEqual(["/tmp/dir", "file.txt"]);
  });

  test("-- terminator", () => {
    const result = parseArgs(["--", "-notaflag"], {});
    expect(result.sawDoubleDash).toBe(true);
    expect(result.positionals).toEqual(["-notaflag"]);
    expect(result.pathArgs).toEqual(["-notaflag"]);
    expect(result.flags.size).toBe(0);
  });

  test("respectsDoubleDash: false", () => {
    const result = parseArgs(["--", "-notaflag"], {
      respectsDoubleDash: false,
    });
    // `--` is treated as a boolean flag, not a terminator.
    expect(result.sawDoubleDash).toBe(false);
    expect(result.flags.get("--")).toBe(true);
    expect(result.flags.get("-notaflag")).toBe(true);
    expect(result.positionals).toEqual([]);
  });

  test("positionals 'paths' (default) — all positionals in pathArgs", () => {
    const result = parseArgs(["a.txt", "b.txt"], {});
    expect(result.positionals).toEqual(["a.txt", "b.txt"]);
    expect(result.pathArgs).toEqual(["a.txt", "b.txt"]);
  });

  test("positionals 'paths' (explicit) — all positionals in pathArgs", () => {
    const result = parseArgs(["a.txt", "b.txt"], { positionals: "paths" });
    expect(result.positionals).toEqual(["a.txt", "b.txt"]);
    expect(result.pathArgs).toEqual(["a.txt", "b.txt"]);
  });

  test("positionals 'none' — no positionals in pathArgs", () => {
    const result = parseArgs(["a.txt", "b.txt"], { positionals: "none" });
    expect(result.positionals).toEqual(["a.txt", "b.txt"]);
    expect(result.pathArgs).toEqual([]);
  });

  test("mixed positionals (array) with rest descriptor", () => {
    const result = parseArgs(["pattern", "file1.txt", "file2.txt"], {
      positionals: [{ role: "pattern" }, { role: "path", rest: true }],
    });
    expect(result.positionals).toEqual(["pattern", "file1.txt", "file2.txt"]);
    // "pattern" has role "pattern" → not a path.
    // "file1.txt" at index 1 has role "path" with rest → path.
    // "file2.txt" at index 2 exceeds array but rest descriptor applies → path.
    expect(result.pathArgs).toEqual(["file1.txt", "file2.txt"]);
  });

  test("positional array without rest — excess positionals default to path", () => {
    const result = parseArgs(["script", "extra1", "extra2"], {
      positionals: [{ role: "script" }],
    });
    expect(result.positionals).toEqual(["script", "extra1", "extra2"]);
    // "script" → role "script" → not a path.
    // "extra1", "extra2" → no descriptor, no rest → conservative default → path.
    expect(result.pathArgs).toEqual(["extra1", "extra2"]);
  });

  test("empty args", () => {
    const result = parseArgs([], {});
    expect(result.flags.size).toBe(0);
    expect(result.positionals).toEqual([]);
    expect(result.pathArgs).toEqual([]);
    expect(result.sawDoubleDash).toBe(false);
  });

  test("value-consuming flag at end of args with no next token — treated as boolean", () => {
    const result = parseArgs(["-o"], { valueFlags: ["-o"] });
    expect(result.flags.get("-o")).toBe(true);
    expect(result.positionals).toEqual([]);
    expect(result.pathArgs).toEqual([]);
  });

  test("positionals after -- are still classified by positional descriptors", () => {
    const result = parseArgs(["--", "pattern", "file.txt"], {
      positionals: [{ role: "pattern" }, { role: "path" }],
    });
    expect(result.sawDoubleDash).toBe(true);
    expect(result.positionals).toEqual(["pattern", "file.txt"]);
    // "pattern" at index 0 → role "pattern" → not a path.
    // "file.txt" at index 1 → role "path" → path.
    expect(result.pathArgs).toEqual(["file.txt"]);
  });

  test("value flag value is not added to pathArgs unless flag is in pathFlags", () => {
    const result = parseArgs(["-o", "/some/path"], {
      valueFlags: ["-o"],
      positionals: "none",
    });
    expect(result.flags.get("-o")).toBe("/some/path");
    // -o is not in pathFlags, so the value is not a path.
    expect(result.pathArgs).toEqual([]);
  });

  test("multiple path flags accumulate in pathArgs", () => {
    const result = parseArgs(["-I", "/include1", "-I", "/include2", "src.c"], {
      valueFlags: ["-I"],
      pathFlags: { "-I": true },
    });
    expect(result.flags.get("-I")).toBe("/include2"); // last value wins in Map
    expect(result.positionals).toEqual(["src.c"]);
    expect(result.pathArgs).toEqual(["/include1", "/include2", "src.c"]);
  });
});
