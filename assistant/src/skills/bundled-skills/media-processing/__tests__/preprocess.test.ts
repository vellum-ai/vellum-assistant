import { describe, expect, it } from "bun:test";

import {
  buildDeadTimeRanges,
  computeEffectiveInterval,
  computeLiveRanges,
  createDefaultSections,
  createSegments,
  generateFrameTimestamps,
  parseDroppedFrameTimestamps,
  sampleFrameIndices,
  type TimeRange,
} from "../services/preprocess.js";

// ---------------------------------------------------------------------------
// parseDroppedFrameTimestamps
// ---------------------------------------------------------------------------

describe("parseDroppedFrameTimestamps", () => {
  it("extracts timestamps from mpdecimate-style stderr lines", () => {
    const stderr = [
      "[Parsed_mpdecimate_0 @ 0x...] pts_time:1.500 drop",
      "[Parsed_mpdecimate_0 @ 0x...] pts_time:3.000 keep",
      "[Parsed_mpdecimate_0 @ 0x...] pts_time:4.200 drop",
      "some other line",
    ].join("\n");

    const result = parseDroppedFrameTimestamps(stderr);
    expect(result).toEqual([1.5, 4.2]);
  });

  it("returns empty array for no drops", () => {
    const stderr = "pts_time:1.0 keep\npts_time:2.0 keep\n";
    expect(parseDroppedFrameTimestamps(stderr)).toEqual([]);
  });

  it("returns sorted timestamps", () => {
    const stderr = [
      "pts_time:10.0 drop",
      "pts_time:2.5 drop",
      "pts_time:5.0 drop",
    ].join("\n");

    expect(parseDroppedFrameTimestamps(stderr)).toEqual([2.5, 5.0, 10.0]);
  });

  it("handles empty string", () => {
    expect(parseDroppedFrameTimestamps("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildDeadTimeRanges
// ---------------------------------------------------------------------------

describe("buildDeadTimeRanges", () => {
  it("groups consecutive timestamps into ranges", () => {
    // Frames every 0.5s from 10.0 to 20.0 (>5s gap = dead time)
    const timestamps: number[] = [];
    for (let t = 10.0; t <= 20.0; t += 0.5) {
      timestamps.push(parseFloat(t.toFixed(1)));
    }

    const ranges = buildDeadTimeRanges(timestamps, 1.0, 5.0);
    expect(ranges).toEqual([{ start: 10.0, end: 20.0 }]);
  });

  it("splits into multiple ranges when gap exceeds threshold", () => {
    const timestamps = [
      1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7,
      // gap of 10 seconds
      17, 17.5, 18, 18.5, 19, 19.5, 20, 20.5, 21, 21.5, 22, 22.5, 23,
    ];

    const ranges = buildDeadTimeRanges(timestamps, 1.0, 5.0);
    expect(ranges).toEqual([
      { start: 1, end: 7 },
      { start: 17, end: 23 },
    ]);
  });

  it("filters out short ranges below minDuration", () => {
    // Only 3 seconds of drops — below the 5s minimum
    const timestamps = [10, 10.5, 11, 11.5, 12, 12.5, 13];
    const ranges = buildDeadTimeRanges(timestamps, 1.0, 5.0);
    expect(ranges).toEqual([]);
  });

  it("returns empty for no timestamps", () => {
    expect(buildDeadTimeRanges([])).toEqual([]);
  });

  it("handles single long range", () => {
    const timestamps = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6];
    const ranges = buildDeadTimeRanges(timestamps, 1.0, 5.0);
    expect(ranges).toEqual([{ start: 0, end: 6 }]);
  });
});

// ---------------------------------------------------------------------------
// computeLiveRanges
// ---------------------------------------------------------------------------

describe("computeLiveRanges", () => {
  it("returns full duration when no dead time", () => {
    const result = computeLiveRanges(300, []);
    expect(result).toEqual([{ start: 0, end: 300 }]);
  });

  it("subtracts dead time from the middle", () => {
    const dead: TimeRange[] = [{ start: 100, end: 150 }];
    const result = computeLiveRanges(300, dead);
    expect(result).toEqual([
      { start: 0, end: 100 },
      { start: 150, end: 300 },
    ]);
  });

  it("handles dead time at the start", () => {
    const dead: TimeRange[] = [{ start: 0, end: 30 }];
    const result = computeLiveRanges(300, dead);
    expect(result).toEqual([{ start: 30, end: 300 }]);
  });

  it("handles dead time at the end", () => {
    const dead: TimeRange[] = [{ start: 280, end: 300 }];
    const result = computeLiveRanges(300, dead);
    expect(result).toEqual([{ start: 0, end: 280 }]);
  });

  it("handles multiple dead-time ranges", () => {
    const dead: TimeRange[] = [
      { start: 50, end: 60 },
      { start: 150, end: 170 },
    ];
    const result = computeLiveRanges(300, dead);
    expect(result).toEqual([
      { start: 0, end: 50 },
      { start: 60, end: 150 },
      { start: 170, end: 300 },
    ]);
  });

  it("handles unsorted dead-time ranges", () => {
    const dead: TimeRange[] = [
      { start: 150, end: 170 },
      { start: 50, end: 60 },
    ];
    const result = computeLiveRanges(300, dead);
    expect(result).toEqual([
      { start: 0, end: 50 },
      { start: 60, end: 150 },
      { start: 170, end: 300 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// createSegments
// ---------------------------------------------------------------------------

describe("createSegments", () => {
  it("creates non-overlapping segments within a single live range", () => {
    const live: TimeRange[] = [{ start: 0, end: 60 }];
    const segments = createSegments(live, 20);
    expect(segments).toEqual([
      { id: "seg-001", startSeconds: 0, endSeconds: 20 },
      { id: "seg-002", startSeconds: 20, endSeconds: 40 },
      { id: "seg-003", startSeconds: 40, endSeconds: 60 },
    ]);
  });

  it("creates a shorter final segment for non-even durations", () => {
    const live: TimeRange[] = [{ start: 0, end: 50 }];
    const segments = createSegments(live, 20);
    expect(segments).toHaveLength(3);
    expect(segments[2]).toEqual({
      id: "seg-003",
      startSeconds: 40,
      endSeconds: 50,
    });
  });

  it("creates segments across multiple live ranges", () => {
    const live: TimeRange[] = [
      { start: 0, end: 30 },
      { start: 60, end: 80 },
    ];
    const segments = createSegments(live, 20);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({
      id: "seg-001",
      startSeconds: 0,
      endSeconds: 20,
    });
    expect(segments[1]).toEqual({
      id: "seg-002",
      startSeconds: 20,
      endSeconds: 30,
    });
    expect(segments[2]).toEqual({
      id: "seg-003",
      startSeconds: 60,
      endSeconds: 80,
    });
  });

  it("uses zero-padded IDs", () => {
    const live: TimeRange[] = [{ start: 0, end: 10 }];
    const segments = createSegments(live, 10);
    expect(segments[0].id).toBe("seg-001");
  });

  it("returns empty for empty live ranges", () => {
    expect(createSegments([], 20)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeEffectiveInterval
// ---------------------------------------------------------------------------

describe("computeEffectiveInterval", () => {
  it("returns requested interval when enough frames would be produced", () => {
    // 20s segment / 3s interval = ~6 frames >= 4 minimum
    expect(computeEffectiveInterval(20, 3)).toBe(3);
  });

  it("reduces interval for short segments to guarantee minimum frames", () => {
    // 8s segment / 3s interval = ~2 frames < 4 minimum
    // Should return 8/4 = 2
    expect(computeEffectiveInterval(8, 3)).toBe(2);
  });

  it("reduces interval for very short segments", () => {
    // 4s segment / 3s interval = 1 frame < 4 minimum
    // Should return 4/4 = 1
    expect(computeEffectiveInterval(4, 3)).toBe(1);
  });

  it("returns requested interval when exactly at minimum", () => {
    // 12s segment / 3s interval = 4 frames = minimum
    expect(computeEffectiveInterval(12, 3)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// generateFrameTimestamps
// ---------------------------------------------------------------------------

describe("generateFrameTimestamps", () => {
  it("generates evenly spaced timestamps within segment bounds", () => {
    const ts = generateFrameTimestamps(0, 20, 3);
    // 0, 3, 6, 9, 12, 15, 18
    expect(ts).toEqual([0, 3, 6, 9, 12, 15, 18]);
  });

  it("uses reduced interval for short segments", () => {
    const ts = generateFrameTimestamps(10, 18, 3);
    // 8s segment, 3s interval gives floor(8/3)=2 frames < 4 min
    // effective interval = 8/4 = 2
    // 10, 12, 14, 16
    expect(ts).toEqual([10, 12, 14, 16]);
  });

  it("handles segment not starting at zero", () => {
    const ts = generateFrameTimestamps(60, 80, 3);
    expect(ts[0]).toBe(60);
    expect(ts[ts.length - 1]).toBeLessThan(80);
  });
});

// ---------------------------------------------------------------------------
// createDefaultSections
// ---------------------------------------------------------------------------

describe("createDefaultSections", () => {
  it("splits duration into two equal halves", () => {
    const sections = createDefaultSections(300);
    expect(sections).toEqual([
      { label: "section_1", startSeconds: 0, endSeconds: 150 },
      { label: "section_2", startSeconds: 150, endSeconds: 300 },
    ]);
  });

  it("handles odd duration", () => {
    const sections = createDefaultSections(301);
    expect(sections[0].endSeconds).toBe(150.5);
    expect(sections[1].startSeconds).toBe(150.5);
  });
});

// ---------------------------------------------------------------------------
// sampleFrameIndices
// ---------------------------------------------------------------------------

describe("sampleFrameIndices", () => {
  it("returns all indices when fewer frames than sample count", () => {
    const indices = sampleFrameIndices(5, 10);
    expect(indices).toEqual([0, 1, 2, 3, 4]);
  });

  it("returns evenly spaced indices for large frame counts", () => {
    const indices = sampleFrameIndices(100, 10);
    expect(indices).toHaveLength(10);
    // Should be roughly evenly spaced
    expect(indices[0]).toBe(0);
    expect(indices[9]).toBeLessThan(100);
  });

  it("returns correct count", () => {
    const indices = sampleFrameIndices(50, 10);
    expect(indices).toHaveLength(10);
  });

  it("handles single frame", () => {
    const indices = sampleFrameIndices(1, 10);
    expect(indices).toEqual([0]);
  });
});
