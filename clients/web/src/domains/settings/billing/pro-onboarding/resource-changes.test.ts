import { describe, expect, test } from "bun:test";

import type { ProvisioningDimensions } from "./provisioning-machine";
import { buildResourceChanges } from "./resource-changes";

const targets: ProvisioningDimensions = { machineSize: "large", storageGib: 50 };
const from: ProvisioningDimensions = { machineSize: "small", storageGib: 10 };

describe("buildResourceChanges", () => {
  test("all three present, ordered machine → storage → credits", () => {
    const changes = buildResourceChanges({
      targets,
      fromSnapshot: from,
      credits: { from: "0", to: "50 credits" },
    });

    expect(changes.map((c) => c.key)).toEqual(["machine", "storage", "credits"]);
    expect(changes[0]).toEqual({
      key: "machine",
      label: "Machine",
      from: "Small",
      to: "Large",
    });
    expect(changes[1]).toEqual({
      key: "storage",
      label: "Storage",
      from: "10 GiB",
      to: "50 GiB",
    });
    expect(changes[2]).toEqual({
      key: "credits",
      label: "Credits",
      from: "0",
      to: "50 credits",
    });
  });

  test("omits machine when the target machineSize is null", () => {
    const changes = buildResourceChanges({
      targets: { machineSize: null, storageGib: 50 },
      fromSnapshot: from,
      credits: null,
    });

    expect(changes.map((c) => c.key)).toEqual(["storage"]);
  });

  test("omits storage when the target storageGib is null", () => {
    const changes = buildResourceChanges({
      targets: { machineSize: "large", storageGib: null },
      fromSnapshot: from,
      credits: null,
    });

    expect(changes.map((c) => c.key)).toEqual(["machine"]);
  });

  test("omits credits when credits is null", () => {
    const changes = buildResourceChanges({
      targets,
      fromSnapshot: from,
      credits: null,
    });

    expect(changes.map((c) => c.key)).toEqual(["machine", "storage"]);
  });

  test("omits `from` when the snapshot dimension is null", () => {
    const changes = buildResourceChanges({
      targets,
      fromSnapshot: { machineSize: null, storageGib: null },
      credits: null,
    });

    expect(changes[0].from).toBeUndefined();
    expect(changes[1].from).toBeUndefined();
  });

  test("omits `from` when the snapshot equals the target", () => {
    const changes = buildResourceChanges({
      targets,
      fromSnapshot: { machineSize: "large", storageGib: 50 },
      credits: null,
    });

    expect(changes[0].from).toBeUndefined();
    expect(changes[1].from).toBeUndefined();
  });

  test("includes `from` when the snapshot differs from the target", () => {
    const changes = buildResourceChanges({
      targets,
      fromSnapshot: from,
      credits: null,
    });

    expect(changes[0].from).toBe("Small");
    expect(changes[1].from).toBe("10 GiB");
  });
});
