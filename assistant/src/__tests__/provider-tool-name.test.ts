import { describe, expect, test } from "bun:test";

import {
  isProviderSafeToolName,
  toProviderSafeToolName,
} from "../tools/provider-tool-name.js";

describe("provider tool names", () => {
  test("leaves already-safe names unchanged", () => {
    expect(toProviderSafeToolName("deploy")).toBe("deploy");
    expect(isProviderSafeToolName("deploy")).toBe(true);
  });

  test("preserves raw-name identity for names that differ by edge whitespace", () => {
    const plain = toProviderSafeToolName("deploy");
    const padded = toProviderSafeToolName(" deploy ");

    expect(plain).toBe("deploy");
    expect(padded).toMatch(/^deploy__[a-f0-9]{12}$/);
    expect(padded).not.toBe(plain);
    expect(isProviderSafeToolName(padded)).toBe(true);
  });
});
