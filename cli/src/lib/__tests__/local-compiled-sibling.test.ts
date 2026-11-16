import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";

import { compiledSiblingSpawnOptions } from "../local.js";

describe("compiledSiblingSpawnOptions", () => {
  const binary = join("runtime", "0.0.0-test", "vellum-gateway");

  test("runs the binary from its own directory so node_modules beside it resolves", () => {
    const options = compiledSiblingSpawnOptions(binary, {});

    expect(options.cwd).toBe(dirname(binary));
    expect(options.env.NODE_PATH).toBe(join(dirname(binary), "node_modules"));
  });

  test("keeps the caller's environment and replaces an inherited NODE_PATH", () => {
    const options = compiledSiblingSpawnOptions(binary, {
      GATEWAY_PORT: "7830",
      NODE_PATH: join("somewhere", "else"),
    });

    expect(options.env.GATEWAY_PORT).toBe("7830");
    expect(options.env.NODE_PATH).toBe(join(dirname(binary), "node_modules"));
  });
});
