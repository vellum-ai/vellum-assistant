import { describe, expect, test } from "bun:test";

import { acpRunStatusBadge } from "@/utils/acp-run-status";

describe("acpRunStatusBadge", () => {
  test("a run cancelled mid-flight (completed + cancelled) shows an amber 'Cancelled'", () => {
    expect(acpRunStatusBadge("completed", "cancelled")).toEqual({
      label: "Cancelled",
      color: "var(--system-mid-strong)",
    });
  });

  test("a cleanly completed run stays a positive 'Completed'", () => {
    expect(acpRunStatusBadge("completed", "end_turn")).toEqual({
      label: "Completed",
      color: "var(--system-positive-strong)",
    });
    expect(acpRunStatusBadge("completed", undefined)).toEqual({
      label: "Completed",
      color: "var(--system-positive-strong)",
    });
  });

  test("a hard-cancelled run keeps the negative 'Cancelled'", () => {
    expect(acpRunStatusBadge("cancelled", undefined)).toEqual({
      label: "Cancelled",
      color: "var(--system-negative-strong)",
    });
  });

  test("falls back to the plain label/color for active and failed runs", () => {
    expect(acpRunStatusBadge("running", undefined).label).toBe("Running");
    expect(acpRunStatusBadge("failed", undefined)).toEqual({
      label: "Failed",
      color: "var(--system-negative-strong)",
    });
  });
});
