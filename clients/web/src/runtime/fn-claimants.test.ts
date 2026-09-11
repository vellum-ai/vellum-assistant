import { beforeEach, describe, expect, mock, test } from "bun:test";

let running: string[] = [];
const asked: string[][] = [];
mock.module("@/runtime/running-apps", () => ({
  runningApps: async (ids: readonly string[]) => {
    asked.push([...ids]);
    return running;
  },
  quitApp: async () => true,
}));

const { FN_CLAIMANTS, findRunningFnClaimant, runningFnClaimantNames } =
  await import("@/runtime/fn-claimants");

const wispr = FN_CLAIMANTS.find((app) => app.quittable)!;
const raycast = FN_CLAIMANTS.find((app) => app.name === "Raycast")!;
const karabiner = FN_CLAIMANTS.filter(
  (app) => app.name === "Karabiner-Elements",
);

describe("the apps that claim the voice key", () => {
  beforeEach(() => {
    running = [];
    asked.length = 0;
  });

  test("none running is no claimant", async () => {
    expect(await findRunningFnClaimant()).toBeNull();
    expect(await runningFnClaimantNames()).toEqual([]);
  });

  test("a running dictation app is the offer's claimant", async () => {
    running = [wispr.bundleId];
    expect(await findRunningFnClaimant()).toEqual(wispr);
  });

  /** A keyboard tool is named, never offered the door. */
  test("a running detection-only claimant is named but is not the offer's", async () => {
    running = [raycast.bundleId];
    expect(await findRunningFnClaimant()).toBeNull();
    expect(asked[0]).not.toContain(raycast.bundleId);
    expect(await runningFnClaimantNames()).toEqual(["Raycast"]);
  });

  test("an app that runs as more than one process is named once", async () => {
    expect(karabiner.length).toBeGreaterThan(1);
    running = karabiner.map((app) => app.bundleId);
    expect(await runningFnClaimantNames()).toEqual(["Karabiner-Elements"]);
  });

  test("an unrelated running app is not one", async () => {
    running = ["com.example.editor"];
    expect(await findRunningFnClaimant()).toBeNull();
    expect(await runningFnClaimantNames()).toEqual([]);
  });
});
