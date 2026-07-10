import { describe, expect, test } from "bun:test";

import { formatCostUsd } from "../cli-output.js";

describe("formatCostUsd", () => {
  test("renders zero as $0.00", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
  });

  test("renders sub-cent amounts with six decimal places", () => {
    expect(formatCostUsd(0.0042)).toBe("$0.004200");
    expect(formatCostUsd(0.000001)).toBe("$0.000001");
  });

  test("renders a cent or more with two decimal places", () => {
    expect(formatCostUsd(0.0123)).toBe("$0.01");
    expect(formatCostUsd(1.5)).toBe("$1.50");
    expect(formatCostUsd(12.345)).toBe("$12.35");
  });
});
