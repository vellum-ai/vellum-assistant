import { beforeEach, describe, expect, it, mock } from "bun:test";

const store = new Map<string, string>();

mock.module("../memory/checkpoints.js", () => ({
  getMemoryCheckpoint: mock((key: string) => store.get(key) ?? null),
  setMemoryCheckpoint: mock((key: string, value: string) =>
    store.set(key, value),
  ),
}));

const {
  getActiveReleases,
  setActiveReleases,
  getCompletedReleases,
  setCompletedReleases,
  isReleaseCompleted,
  markReleasesCompleted,
  addActiveRelease,
} = await import("../prompts/update-bulletin-state.js");

describe("update-bulletin-state", () => {
  beforeEach(() => {
    store.clear();
  });

  describe("empty/default state", () => {
    it("returns empty array when no active releases checkpoint exists", () => {
      expect(getActiveReleases()).toEqual([]);
    });

    it("returns empty array when no completed releases checkpoint exists", () => {
      expect(getCompletedReleases()).toEqual([]);
    });

    it("isReleaseCompleted returns false when no completed releases exist", () => {
      expect(isReleaseCompleted("1.0.0")).toBe(false);
    });
  });

  describe("corrupt checkpoint content", () => {
    it("returns empty array for invalid JSON in active releases", () => {
      store.set("updates:active_releases", "not-json{{{");
      expect(getActiveReleases()).toEqual([]);
    });

    it("returns empty array for invalid JSON in completed releases", () => {
      store.set("updates:completed_releases", "}{broken");
      expect(getCompletedReleases()).toEqual([]);
    });

    it("returns empty array when checkpoint contains a non-array JSON value", () => {
      store.set("updates:active_releases", '"just-a-string"');
      expect(getActiveReleases()).toEqual([]);
    });

    it("filters out non-string values from the array", () => {
      store.set("updates:active_releases", '["1.0.0", 42, null, "2.0.0"]');
      expect(getActiveReleases()).toEqual(["1.0.0", "2.0.0"]);
    });
  });

  describe("round-trip serialization", () => {
    it("write then read returns same data for active releases", () => {
      const releases = ["1.0.0", "2.0.0", "3.0.0"];
      setActiveReleases(releases);
      expect(getActiveReleases()).toEqual(releases);
    });

    it("write then read returns same data for completed releases", () => {
      const releases = ["0.9.0", "1.0.0"];
      setCompletedReleases(releases);
      expect(getCompletedReleases()).toEqual(releases);
    });

    it("isReleaseCompleted returns true for a completed release", () => {
      setCompletedReleases(["1.0.0", "2.0.0"]);
      expect(isReleaseCompleted("1.0.0")).toBe(true);
      expect(isReleaseCompleted("2.0.0")).toBe(true);
      expect(isReleaseCompleted("3.0.0")).toBe(false);
    });
  });

  describe("dedupe behavior", () => {
    it("setActiveReleases deduplicates entries", () => {
      setActiveReleases(["1.0.0", "2.0.0", "1.0.0", "2.0.0", "1.0.0"]);
      expect(getActiveReleases()).toEqual(["1.0.0", "2.0.0"]);
    });

    it("setCompletedReleases deduplicates entries", () => {
      setCompletedReleases(["a", "b", "a"]);
      expect(getCompletedReleases()).toEqual(["a", "b"]);
    });

    it("addActiveRelease does not duplicate an existing release", () => {
      setActiveReleases(["1.0.0"]);
      addActiveRelease("1.0.0");
      expect(getActiveReleases()).toEqual(["1.0.0"]);
    });

    it("markReleasesCompleted does not duplicate existing entries", () => {
      setCompletedReleases(["1.0.0"]);
      markReleasesCompleted(["1.0.0", "2.0.0"]);
      expect(getCompletedReleases()).toEqual(["1.0.0", "2.0.0"]);
    });
  });

  describe("sort behavior", () => {
    it("active releases are sorted alphabetically", () => {
      setActiveReleases(["c-release", "a-release", "b-release"]);
      expect(getActiveReleases()).toEqual([
        "a-release",
        "b-release",
        "c-release",
      ]);
    });

    it("completed releases are sorted alphabetically", () => {
      setCompletedReleases(["3.0.0", "1.0.0", "2.0.0"]);
      expect(getCompletedReleases()).toEqual(["1.0.0", "2.0.0", "3.0.0"]);
    });

    it("addActiveRelease maintains sorted order", () => {
      setActiveReleases(["a", "c"]);
      addActiveRelease("b");
      expect(getActiveReleases()).toEqual(["a", "b", "c"]);
    });

    it("markReleasesCompleted maintains sorted order", () => {
      setCompletedReleases(["c"]);
      markReleasesCompleted(["a", "b"]);
      expect(getCompletedReleases()).toEqual(["a", "b", "c"]);
    });
  });
});
