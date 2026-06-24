import { describe, expect, it } from "bun:test";

import {
  classifyHosting,
  destinationDescription,
  destinationLabel,
  parseVersionMismatch,
  resolveDestination,
} from "./teleport-types";

describe("classifyHosting", () => {
  it("maps known cloud values, case-insensitively", () => {
    expect(classifyHosting("local")).toBe("local");
    expect(classifyHosting("docker")).toBe("docker");
    expect(classifyHosting("vellum")).toBe("managed");
    expect(classifyHosting("Vellum")).toBe("managed");
  });

  it("treats unknown or missing values as other", () => {
    expect(classifyHosting(undefined)).toBe("other");
    expect(classifyHosting("")).toBe("other");
    expect(classifyHosting("apple-container")).toBe("other");
  });
});

describe("resolveDestination", () => {
  it("offers local for managed assistants", () => {
    expect(resolveDestination("vellum")).toBe("local");
  });

  it("offers platform for local assistants", () => {
    expect(resolveDestination("local")).toBe("platform");
  });

  it("offers nothing for assistants without a local-gateway transport", () => {
    // Docker has no web export transport; apple-container/unknown are out of scope.
    expect(resolveDestination("docker")).toBeNull();
    expect(resolveDestination("apple-container")).toBeNull();
    expect(resolveDestination(undefined)).toBeNull();
  });
});

describe("destination copy", () => {
  it("has a label and description for each destination", () => {
    for (const dest of ["docker", "platform", "local"] as const) {
      expect(destinationLabel(dest).length).toBeGreaterThan(0);
      expect(destinationDescription(dest).length).toBeGreaterThan(0);
    }
  });
});

describe("parseVersionMismatch", () => {
  it("formats a bounded compat range", () => {
    const message = parseVersionMismatch({
      reason: "version_mismatch",
      target_runtime_version: "1.2.0",
      bundle_compat: {
        min_runtime_version: "1.5.0",
        max_runtime_version: "2.0.0",
      },
    });
    expect(message).toContain("1.5.0–2.0.0");
    expect(message).toContain("1.2.0");
  });

  it("formats an open-ended compat range", () => {
    const message = parseVersionMismatch({
      reason: "version_mismatch",
      target_runtime_version: "1.2.0",
      bundle_compat: { min_runtime_version: "1.5.0" },
    });
    expect(message).toContain("1.5.0+");
  });

  it("returns null for non-version-mismatch or malformed bodies", () => {
    expect(parseVersionMismatch(null)).toBeNull();
    expect(parseVersionMismatch({ reason: "other" })).toBeNull();
    expect(
      parseVersionMismatch({ reason: "version_mismatch", bundle_compat: {} }),
    ).toBeNull();
  });
});
