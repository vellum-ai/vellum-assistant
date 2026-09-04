import { beforeEach, describe, expect, mock, test } from "bun:test";

let running: string[] = [];
mock.module("@/runtime/running-apps", () => ({
  runningApps: async (_ids: readonly string[]) => running,
  quitApp: async () => true,
}));

const { FN_CLAIMANTS, findRunningFnClaimant } =
  await import("@/domains/chat/voice/fn-claimants");

describe("the apps that claim Fn", () => {
  beforeEach(() => {
    running = [];
  });

  test("none running is no claimant", async () => {
    expect(await findRunningFnClaimant()).toBeNull();
  });

  test("a running one is named", async () => {
    running = [FN_CLAIMANTS[0]!.bundleId];
    expect(await findRunningFnClaimant()).toEqual(FN_CLAIMANTS[0]);
  });

  test("an unrelated running app is not one", async () => {
    running = ["com.example.editor"];
    expect(await findRunningFnClaimant()).toBeNull();
  });
});
