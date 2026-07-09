import { describe, expect, test } from "bun:test";

import { isValidReleaseVersion } from "@vellumai/local-mode";

import type { LocalInstanceResources } from "../lib/assistant-config.js";
import { ensureLocalRuntime } from "../lib/local.js";

// Only `instanceDir` is read, and only after the validation guard passes —
// invalid versions throw before any filesystem access, so a minimal stub is
// sufficient for the rejection cases.
const resources = {
  instanceDir: "/tmp/vellum-nonexistent-instance",
} as unknown as LocalInstanceResources;

const VALID_VERSIONS = ["latest", "v1.2.3", "1.2.3", "0.6.0-staging.5"];
const MALICIOUS_VERSIONS = [
  "npm:@attacker/evil@1.0.0",
  "https://evil.example/x.tgz",
  "git+https://evil.example/x.git",
  "../../../../tmp/evil",
  "1.2.3-..",
  "1.2.3-a..b",
];

describe("ensureLocalRuntime version guard", () => {
  test("shares the trusted-release validator with the host boundary", () => {
    for (const version of VALID_VERSIONS) {
      expect(isValidReleaseVersion(version)).toBe(true);
    }
    for (const version of MALICIOUS_VERSIONS) {
      expect(isValidReleaseVersion(version)).toBe(false);
    }
  });

  test("throws before any install for untrusted versions", () => {
    for (const version of MALICIOUS_VERSIONS) {
      expect(() => ensureLocalRuntime(resources, version)).toThrow(
        `Invalid runtime version '${version}'`,
      );
    }
  });
});
