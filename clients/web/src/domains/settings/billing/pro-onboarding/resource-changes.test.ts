import { describe, expect, test } from "bun:test";

import type { ProvisioningDimensions } from "./provisioning-machine";
import { buildResourceChanges } from "./resource-changes";

const targets: ProvisioningDimensions = {
  machineSize: "large",
  storageGib: 50,
};
const from: ProvisioningDimensions = { machineSize: "small", storageGib: 10 };

describe("buildResourceChanges", () => {
  test("all three present, ordered machine → storage → credits", () => {
    const changes = buildResourceChanges({
      targets,
      fromSnapshot: from,
      credits: { from: "0", to: "50 credits" },
    });

    expect(changes.map((c) => c.key)).toEqual([
      "machine",
      "storage",
      "credits",
    ]);
    expect(changes[0]).toEqual({
      key: "machine",
      label: "Machine",
      from: "Small",
      to: "Large",
    });
    expect(changes[1]).toEqual({
      key: "storage",
      label: "Storage",
      from: "10 GB",
      to: "50 GB",
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

  test("omits machine when the snapshot already equals the target", () => {
    const changes = buildResourceChanges({
      targets,
      fromSnapshot: { machineSize: "large", storageGib: 50 },
      credits: null,
    });

    expect(changes).toEqual([]);
  });

  test("keeps a credit-only change free of a machine row", () => {
    // The live targets carry the tier ceiling, so the machine target is non-null
    // for any paid tier even when the change never touched the machine.
    const changes = buildResourceChanges({
      targets: { machineSize: "large", storageGib: 50 },
      fromSnapshot: { machineSize: "large", storageGib: 50 },
      credits: { from: "$25/mo", to: "$50/mo" },
    });

    expect(changes.map((c) => c.key)).toEqual(["credits"]);
  });

  test("takes the credits label override the obscured wording passes", () => {
    const changes = buildResourceChanges({
      targets: { machineSize: null, storageGib: null },
      fromSnapshot: { machineSize: null, storageGib: null },
      credits: { label: "Usage", from: "No extra usage", to: "Mighty Usage" },
    });

    expect(changes).toEqual([
      {
        key: "credits",
        label: "Usage",
        from: "No extra usage",
        to: "Mighty Usage",
      },
    ]);
  });

  test("keeps a storage-only change free of a machine row", () => {
    const changes = buildResourceChanges({
      targets: { machineSize: "medium", storageGib: 50 },
      fromSnapshot: { machineSize: "medium", storageGib: 10 },
      credits: null,
    });

    expect(changes).toEqual([
      { key: "storage", label: "Storage", from: "10 GB", to: "50 GB" },
    ]);
  });

  test("renders machine with no from-side when the snapshot machine is null", () => {
    const changes = buildResourceChanges({
      targets: { machineSize: "large", storageGib: null },
      fromSnapshot: { machineSize: null, storageGib: null },
      credits: null,
    });

    expect(changes).toEqual([
      { key: "machine", label: "Machine", from: undefined, to: "Large" },
    ]);
  });

  test("ignores the machine floor when the target machine is met, not just set", () => {
    // A non-null machine target reserves the row; the floor branch stays
    // reserved for the machine-less packages that have no target at all.
    const changes = buildResourceChanges({
      targets: { machineSize: "medium", storageGib: null },
      fromSnapshot: { machineSize: "medium", storageGib: null },
      machineFloor: "small",
      credits: null,
    });

    expect(changes).toEqual([]);
  });

  test("includes `from` when the snapshot differs from the target", () => {
    const changes = buildResourceChanges({
      targets,
      fromSnapshot: from,
      credits: null,
    });

    expect(changes[0].from).toBe("Small");
    expect(changes[1].from).toBe("10 GB");
  });

  test("omits storage when the target equals the snapshot", () => {
    const changes = buildResourceChanges({
      targets: { machineSize: null, storageGib: 30 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
      credits: null,
    });

    expect(changes).toEqual([]);
  });

  test("omits storage when the target is below the snapshot", () => {
    const changes = buildResourceChanges({
      targets: { machineSize: null, storageGib: 10 },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
      credits: null,
    });

    expect(changes).toEqual([]);
  });

  test("renders storage when the snapshot is null", () => {
    const changes = buildResourceChanges({
      targets: { machineSize: null, storageGib: 10 },
      fromSnapshot: { machineSize: null, storageGib: null },
      credits: null,
    });

    expect(changes).toEqual([
      { key: "storage", label: "Storage", from: undefined, to: "10 GB" },
    ]);
  });

  test("renders storage when it grows", () => {
    const changes = buildResourceChanges({
      targets: { machineSize: null, storageGib: 30 },
      fromSnapshot: { machineSize: null, storageGib: 10 },
      credits: null,
    });

    expect(changes).toEqual([
      { key: "storage", label: "Storage", from: "10 GB", to: "30 GB" },
    ]);
  });

  test("renders the machine floor when the snapshot machine differs", () => {
    const changes = buildResourceChanges({
      targets: { machineSize: null, storageGib: null },
      fromSnapshot: { machineSize: "medium", storageGib: 30 },
      machineFloor: "small",
      credits: null,
    });

    expect(changes).toEqual([
      { key: "machine", label: "Machine", from: "Medium", to: "Small" },
    ]);
  });

  test("omits the machine floor when the pod already sits at the floor", () => {
    const changes = buildResourceChanges({
      targets: { machineSize: null, storageGib: null },
      fromSnapshot: { machineSize: "small", storageGib: 30 },
      machineFloor: "small",
      credits: null,
    });

    expect(changes).toEqual([]);
  });

  test("omits the machine floor when the snapshot machine is null", () => {
    const changes = buildResourceChanges({
      targets: { machineSize: null, storageGib: null },
      fromSnapshot: { machineSize: null, storageGib: null },
      machineFloor: "small",
      credits: null,
    });

    expect(changes).toEqual([]);
  });

  test("ignores the machine floor when the target machineSize is set", () => {
    const changes = buildResourceChanges({
      targets: { machineSize: "large", storageGib: null },
      fromSnapshot: { machineSize: "medium", storageGib: null },
      machineFloor: "small",
      credits: null,
    });

    expect(changes).toEqual([
      { key: "machine", label: "Machine", from: "Medium", to: "Large" },
    ]);
  });
});
