import { describe, expect, test } from "bun:test";

import { classifyProcess } from "./orphan-detection.js";

describe("classifyProcess", () => {
  test("spares a live tunnel session launched via a script path", () => {
    expect(
      classifyProcess(
        "bun /Users/x/.nvm/versions/node/v22.14.0/bin/vellum tunnel --provider ngrok",
      ),
    ).toBe("unknown");
  });

  test("spares interactive subcommands like logs and terminal", () => {
    expect(classifyProcess("vellum logs foo")).toBe("unknown");
    expect(classifyProcess("vellum terminal")).toBe("unknown");
  });

  test("spares the other long-running interactive subcommands", () => {
    expect(classifyProcess("vellum events")).toBe("unknown");
    expect(classifyProcess("vellum client")).toBe("unknown");
    expect(classifyProcess("vellum ssh quiet-finch")).toBe("unknown");
    expect(classifyProcess("vellum exec quiet-finch ls")).toBe("unknown");
    expect(classifyProcess("vellum message quiet-finch hi")).toBe("unknown");
    expect(classifyProcess("vellum workflows")).toBe("unknown");
    expect(classifyProcess("vellum-cli tunnel --provider ngrok")).toBe(
      "unknown",
    );
  });

  test("still classifies non-interactive CLI wrappers as vellum", () => {
    expect(classifyProcess("vellum hatch")).toBe("vellum");
    expect(classifyProcess("vellum")).toBe("vellum");
    expect(classifyProcess("/usr/bin/vellum sleep")).toBe("vellum");
  });

  test("service process classifications are unchanged", () => {
    expect(classifyProcess("/opt/homebrew/bin/qdrant --config foo")).toBe(
      "qdrant",
    );
    expect(classifyProcess("bun /x/bin/vellum-gateway --port 7830")).toBe(
      "gateway",
    );
    expect(classifyProcess("bun /x/bin/vellum-daemon start")).toBe("assistant");
    expect(classifyProcess("node daemon start")).toBe("assistant");
    expect(
      classifyProcess("bun /x/bin/vellum-openclaw-adapter --port 9000"),
    ).toBe("openclaw-adapter");
  });

  test("macOS desktop app processes stay excluded", () => {
    expect(
      classifyProcess("/Applications/Vellum.app/Contents/MacOS/Vellum"),
    ).toBe("unknown");
  });

  test("repo paths containing vellum do not match", () => {
    expect(
      classifyProcess(
        "node /Users/runner/work/vellum-assistant/vellum-assistant/scripts/build.js",
      ),
    ).toBe("unknown");
  });
});
