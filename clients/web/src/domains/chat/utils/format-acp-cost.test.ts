import { describe, expect, test } from "bun:test";

import { formatAcpCost } from "./format-acp-cost";

describe("formatAcpCost", () => {
  test("formats a normal USD amount", () => {
    expect(formatAcpCost(1.23, "USD")).toBe("$1.23");
  });

  test("renders a sub-cent amount as a less-than-one-cent form", () => {
    expect(formatAcpCost(0.004, "USD")).toBe("<$0.01");
  });

  test("formats zero as the plain currency value", () => {
    expect(formatAcpCost(0, "USD")).toBe("$0.00");
  });
});
