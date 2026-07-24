import { describe, expect, test } from "bun:test";

import { targetsMet } from "./provisioning-targets";

describe("targetsMet", () => {
  test("null targets are never met", () => {
    expect(targetsMet(null, { machineSize: "large", storageGib: 50 })).toBe(
      false,
    );
  });

  test("both dimensions met → true", () => {
    expect(
      targetsMet(
        { machineSize: "large", storageGib: 50 },
        { machineSize: "large", storageGib: 50 },
      ),
    ).toBe(true);
  });

  test("machine compared by rank — a larger actual than the target counts", () => {
    expect(
      targetsMet(
        { machineSize: "large", storageGib: 50 },
        { machineSize: "extra_large", storageGib: 50 },
      ),
    ).toBe(true);
  });

  test("machine below the target → false", () => {
    expect(
      targetsMet(
        { machineSize: "large", storageGib: 50 },
        { machineSize: "small", storageGib: 50 },
      ),
    ).toBe(false);
  });

  test("machine met but storage short → false", () => {
    expect(
      targetsMet(
        { machineSize: "large", storageGib: 50 },
        { machineSize: "large", storageGib: 25 },
      ),
    ).toBe(false);
  });

  test("null machine target (Mighty) is satisfied by storage alone", () => {
    expect(
      targetsMet(
        { machineSize: null, storageGib: 25 },
        { machineSize: "small", storageGib: 25 },
      ),
    ).toBe(true);
  });

  test("null storage target dimension is treated as satisfied", () => {
    expect(
      targetsMet(
        { machineSize: "medium", storageGib: null },
        { machineSize: "medium", storageGib: null },
      ),
    ).toBe(true);
  });

  test("both target dimensions null → met", () => {
    expect(
      targetsMet(
        { machineSize: null, storageGib: null },
        { machineSize: "small", storageGib: 10 },
      ),
    ).toBe(true);
  });

  test("null actuals cannot meet a non-null machine target", () => {
    expect(
      targetsMet({ machineSize: "large", storageGib: null }, null),
    ).toBe(false);
  });

  test("null actual storage cannot meet a non-null storage target", () => {
    expect(
      targetsMet(
        { machineSize: null, storageGib: 50 },
        { machineSize: null, storageGib: null },
      ),
    ).toBe(false);
  });
});
