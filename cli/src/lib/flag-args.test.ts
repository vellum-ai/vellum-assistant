import { describe, expect, test, spyOn } from "bun:test";

import { parseFeatureFlagArgs } from "./flag-args";

describe("parseFeatureFlagArgs", () => {
  test("single flag produces env var and empty remaining", () => {
    const result = parseFeatureFlagArgs(["--flag", "voice-mode=true"]);
    expect(result).toEqual({
      envVars: { VELLUM_FLAG_VOICE_MODE: "true" },
      remaining: [],
    });
  });

  test("multiple flags produce multiple env vars", () => {
    const result = parseFeatureFlagArgs([
      "--flag",
      "a=1",
      "--flag",
      "b=0",
    ]);
    expect(result).toEqual({
      envVars: { VELLUM_FLAG_A: "1", VELLUM_FLAG_B: "0" },
      remaining: [],
    });
  });

  test("flags mixed with other args preserves remaining", () => {
    const result = parseFeatureFlagArgs([
      "--watch",
      "--flag",
      "x=y",
      "--name",
      "foo",
    ]);
    expect(result).toEqual({
      envVars: { VELLUM_FLAG_X: "y" },
      remaining: ["--watch", "--name", "foo"],
    });
  });

  test("exits with error when --flag has no following argument", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    expect(() => parseFeatureFlagArgs(["--flag"])).toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(
      "Error: --flag requires a key=value argument",
    );

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("exits with error when value has no equals sign", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    expect(() => parseFeatureFlagArgs(["--flag", "noequals"])).toThrow(
      "process.exit",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'Error: --flag value must be in key=value format, got "noequals"',
    );

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("exits with error when key is not kebab-case", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    expect(() => parseFeatureFlagArgs(["--flag", "UPPER=true"])).toThrow(
      "process.exit",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'Error: invalid flag key "UPPER". Keys must be kebab-case (e.g. "voice-mode")',
    );

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
