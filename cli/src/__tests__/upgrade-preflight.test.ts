import { describe, expect, test } from "bun:test";

import {
  evaluateUpgradePoll,
  resolveUpgradeTarget,
} from "../lib/upgrade-preflight.js";

const RELEASES = [
  { version: "0.8.0", is_stable: false },
  { version: "0.7.0" },
  { version: "0.6.0" },
];

describe("resolveUpgradeTarget", () => {
  test("explicit version present in releases resolves ok", () => {
    const result = resolveUpgradeTarget({
      explicitVersion: "v0.7.0",
      releases: RELEASES,
      currentVersion: "0.6.0",
    });
    expect(result.kind).toBe("ok");
    expect(result.target).toBe("v0.7.0");
    expect(result.isNoOp).toBe(false);
    expect(result.isDowngrade).toBe(false);
  });

  test("explicit version absent from releases is version-not-found", () => {
    const result = resolveUpgradeTarget({
      explicitVersion: "v9.9.9",
      releases: RELEASES,
      currentVersion: "0.6.0",
    });
    expect(result.kind).toBe("version-not-found");
    expect(result.target).toBeNull();
  });

  test("explicit version is trusted when releases are unavailable", () => {
    const result = resolveUpgradeTarget({
      explicitVersion: "v0.7.0",
      releases: null,
      currentVersion: "0.6.0",
    });
    expect(result.kind).toBe("ok");
    expect(result.target).toBe("v0.7.0");
  });

  test("default target skips non-stable heads", () => {
    const result = resolveUpgradeTarget({
      explicitVersion: null,
      releases: RELEASES,
      currentVersion: "0.6.0",
    });
    expect(result.kind).toBe("ok");
    expect(result.target).toBe("0.7.0");
  });

  test("default target falls back to first release when none are stable", () => {
    const result = resolveUpgradeTarget({
      explicitVersion: null,
      releases: [{ version: "0.8.0", is_stable: false }],
      currentVersion: "0.6.0",
    });
    expect(result.target).toBe("0.8.0");
  });

  test("no explicit version with unreachable releases is no-releases", () => {
    const result = resolveUpgradeTarget({
      explicitVersion: null,
      releases: null,
      currentVersion: "0.6.0",
    });
    expect(result.kind).toBe("no-releases");
    expect(result.target).toBeNull();
  });

  test("no explicit version with empty releases is no-releases", () => {
    const result = resolveUpgradeTarget({
      explicitVersion: null,
      releases: [],
      currentVersion: "0.6.0",
    });
    expect(result.kind).toBe("no-releases");
  });

  test("detects no-op across v prefix", () => {
    const result = resolveUpgradeTarget({
      explicitVersion: "v0.7.0",
      releases: RELEASES,
      currentVersion: "0.7.0",
    });
    expect(result.isNoOp).toBe(true);
    expect(result.isDowngrade).toBe(false);
  });

  test("detects downgrade", () => {
    const result = resolveUpgradeTarget({
      explicitVersion: "v0.6.0",
      releases: RELEASES,
      currentVersion: "0.7.0",
    });
    expect(result.isDowngrade).toBe(true);
    expect(result.isNoOp).toBe(false);
  });

  test("unknown current version yields no flags", () => {
    const result = resolveUpgradeTarget({
      explicitVersion: "v0.7.0",
      releases: RELEASES,
      currentVersion: undefined,
    });
    expect(result.comparison).toBeNull();
    expect(result.isNoOp).toBe(false);
    expect(result.isDowngrade).toBe(false);
  });
});

describe("evaluateUpgradePoll", () => {
  test("known target completes on version match", () => {
    expect(
      evaluateUpgradePoll({
        targetVersion: "v0.7.0",
        initialVersion: "0.6.0",
        observedVersion: "0.7.0",
        inProgress: null,
        sawInProgress: false,
      }),
    ).toBe("complete");
  });

  test("known target pends until the version matches", () => {
    expect(
      evaluateUpgradePoll({
        targetVersion: "0.7.0",
        initialVersion: "0.6.0",
        observedVersion: "0.6.0",
        inProgress: false,
        sawInProgress: false,
      }),
    ).toBe("pending");
  });

  test("unknown target completes when the in-progress lock releases", () => {
    expect(
      evaluateUpgradePoll({
        targetVersion: null,
        initialVersion: "0.6.0",
        observedVersion: "0.6.0",
        inProgress: false,
        sawInProgress: true,
      }),
    ).toBe("complete");
  });

  test("unknown target pends while the lock was never observed", () => {
    expect(
      evaluateUpgradePoll({
        targetVersion: null,
        initialVersion: "0.6.0",
        observedVersion: "0.6.0",
        inProgress: false,
        sawInProgress: false,
      }),
    ).toBe("pending");
  });

  test("unknown target without upgrade-status completes on version change", () => {
    expect(
      evaluateUpgradePoll({
        targetVersion: null,
        initialVersion: "0.6.0",
        observedVersion: "0.7.0",
        inProgress: null,
        sawInProgress: false,
      }),
    ).toBe("complete");
  });

  test("unknown target completes on version change even when the lock was never observed", () => {
    // Upgrade finished before the first poll: in_progress already false,
    // sawInProgress never set — the version change alone must complete.
    expect(
      evaluateUpgradePoll({
        targetVersion: null,
        initialVersion: "0.6.0",
        observedVersion: "0.7.0",
        inProgress: false,
        sawInProgress: false,
      }),
    ).toBe("complete");
  });

  test("unknown target without upgrade-status pends while the version is unchanged", () => {
    expect(
      evaluateUpgradePoll({
        targetVersion: null,
        initialVersion: "0.6.0",
        observedVersion: "v0.6.0",
        inProgress: null,
        sawInProgress: false,
      }),
    ).toBe("pending");
  });
});
