import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  recordCommit,
  recordUpdate,
  resetCommitPressure,
  snapshotCommitPressure,
} from "@/lib/commit-pressure";

// The probe reads `performance.now()`; drive it from the test so bucket
// rollover and back-to-back detection are exercised without real waiting.
let clock = 0;
let realNow: () => number;

beforeEach(() => {
  clock = 1000;
  realNow = performance.now.bind(performance);
  performance.now = () => clock;
  resetCommitPressure();
});

afterEach(() => {
  performance.now = realNow;
  resetCommitPressure();
});

describe("commit-pressure probe", () => {
  test("reports null until something is recorded", () => {
    expect(snapshotCommitPressure()).toBeNull();
  });

  test("tallies updates per source, highest first", () => {
    recordUpdate("smooth-stream");
    recordUpdate("smooth-stream");
    recordUpdate("smooth-stream");
    recordUpdate("transcript-scroll");

    const snapshot = snapshotCommitPressure();
    expect(snapshot?.updates).toBe(4);
    expect(snapshot?.sources).toEqual({
      "smooth-stream": 3,
      "transcript-scroll": 1,
    });
    // Highest-count source must come first so a truncated payload keeps the
    // signal.
    expect(Object.keys(snapshot?.sources ?? {})[0]).toBe("smooth-stream");
  });

  test("keeps the previous bucket so a snapshot always has ~1s of history", () => {
    recordUpdate("avatar-morph");
    clock += 1200; // roll into a new bucket
    recordUpdate("smooth-stream");

    const snapshot = snapshotCommitPressure();
    expect(snapshot?.updates).toBe(2);
    expect(snapshot?.sources["avatar-morph"]).toBe(1);
  });

  test("drops history after an idle gap rather than reporting stale pressure", () => {
    recordUpdate("avatar-morph");
    clock += 5000;

    expect(snapshotCommitPressure()).toBeNull();
  });

  test("counts a run of sub-frame commits as back-to-back", () => {
    for (let i = 0; i < 12; i += 1) {
      recordCommit();
      clock += 2; // well inside one frame
    }

    const snapshot = snapshotCommitPressure();
    expect(snapshot?.commits).toBe(12);
    expect(snapshot?.maxBackToBackCommits).toBe(12);
  });

  test("a paced commit stream does not register as back-to-back", () => {
    for (let i = 0; i < 12; i += 1) {
      recordCommit();
      clock += 33; // ~30fps — React yielded between commits
    }

    const snapshot = snapshotCommitPressure();
    expect(snapshot?.maxBackToBackCommits).toBe(1);
  });

  test("remembers the longest run, not the most recent one", () => {
    for (let i = 0; i < 6; i += 1) {
      recordCommit();
      clock += 1;
    }
    clock += 50; // breather
    recordCommit();

    expect(snapshotCommitPressure()?.maxBackToBackCommits).toBe(6);
  });

  test("caps distinct sources so the payload stays bounded", () => {
    for (let i = 0; i < 40; i += 1) {
      recordUpdate(`source-${i}`);
    }

    const snapshot = snapshotCommitPressure();
    expect(snapshot?.updates).toBe(40);
    expect(Object.keys(snapshot?.sources ?? {}).length).toBeLessThanOrEqual(25);
    expect(snapshot?.sources.other).toBe(16);
  });

  test("a commit preceded by a recorded update is attributed", () => {
    recordUpdate("smooth-stream");
    recordCommit();

    const snapshot = snapshotCommitPressure();
    expect(snapshot?.commits).toBe(1);
    expect(snapshot?.unattributedCommits).toBe(0);
    expect(snapshot?.maxUnattributedCommits).toBe(0);
  });

  test("one update attributes only the next commit, not a cascade behind it", () => {
    // The LUM-3062 shape: an instrumented update drives a commit, then an
    // uninstrumented effect setState drives another. The cascade commit has
    // no recorded update of its own and must count as unattributed.
    recordUpdate("transcript-scroll");
    recordCommit();
    clock += 2;
    recordCommit();

    const snapshot = snapshotCommitPressure();
    expect(snapshot?.commits).toBe(2);
    expect(snapshot?.unattributedCommits).toBe(1);
    expect(snapshot?.maxUnattributedCommits).toBe(1);
  });

  test("tracks the longest unattributed run across interleaved attributed traffic", () => {
    for (let i = 0; i < 5; i += 1) {
      recordCommit();
      clock += 2;
    }
    recordUpdate("smooth-stream");
    recordCommit(); // attributed, breaks the run
    clock += 2;
    for (let i = 0; i < 3; i += 1) {
      recordCommit();
      clock += 2;
    }

    const snapshot = snapshotCommitPressure();
    expect(snapshot?.commits).toBe(9);
    expect(snapshot?.unattributedCommits).toBe(8);
    expect(snapshot?.maxUnattributedCommits).toBe(5);
  });

  test("unattributed run survives a bucket rollover", () => {
    for (let i = 0; i < 4; i += 1) {
      recordCommit();
      clock += 2;
    }
    clock += 1100; // roll into the next bucket, no idle gap
    for (let i = 0; i < 4; i += 1) {
      recordCommit();
      clock += 2;
    }

    // Rollover is not an update; the run keeps growing across it.
    expect(snapshotCommitPressure()?.maxUnattributedCommits).toBe(8);
  });

  test("idle gap clears attribution state along with the tallies", () => {
    recordUpdate("smooth-stream");
    for (let i = 0; i < 4; i += 1) {
      recordCommit();
      clock += 2;
    }
    clock += 5000; // idle: everything on record is stale
    recordCommit();

    const snapshot = snapshotCommitPressure();
    expect(snapshot?.commits).toBe(1);
    // The pre-gap update must not attribute a post-gap commit.
    expect(snapshot?.unattributedCommits).toBe(1);
    expect(snapshot?.maxUnattributedCommits).toBe(1);
  });
});
