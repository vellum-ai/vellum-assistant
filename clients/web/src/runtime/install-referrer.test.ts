import { beforeEach, expect, mock, test } from "bun:test";

let platform = "android";
const read = mock(async (): Promise<{ referrer?: string }> => ({}));

mock.module("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => platform },
  registerPlugin: () => ({ read }),
}));

const {
  captureInstallReferrer,
  markInstallReferrerSpent,
  readStoredInstallReferrer,
} = await import("./install-referrer");

const STORAGE_KEY = "device:install_referrer";

beforeEach(() => {
  platform = "android";
  localStorage.clear();
  mock.clearAllMocks();
  read.mockResolvedValue({});
});

test("does not touch the bridge outside Android", async () => {
  for (const other of ["web", "ios"]) {
    platform = other;
    await captureInstallReferrer();
  }
  expect(read).not.toHaveBeenCalled();
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
});

test("swallows a shell whose plugin predates this bundle", async () => {
  read.mockRejectedValueOnce(
    new Error('"InstallReferrer" plugin is not implemented on android'),
  );
  await captureInstallReferrer();
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  expect(readStoredInstallReferrer()).toEqual({});
});

test("stores only allowlisted params from a campaign referrer", async () => {
  read.mockResolvedValueOnce({
    referrer:
      "utm_source=newsletter&utm_medium=email&utm_campaign=spring&gclid=abc123&anid=admob&not_a_param=x",
  });
  await captureInstallReferrer();

  expect(readStoredInstallReferrer()).toEqual({
    utm_source: "newsletter",
    utm_medium: "email",
    utm_campaign: "spring",
    gclid: "abc123",
  });
  const stored = localStorage.getItem(STORAGE_KEY) ?? "";
  expect(stored).not.toContain("anid");
  expect(stored).not.toContain("not_a_param");
});

test("stores the organic Play install signal", async () => {
  read.mockResolvedValueOnce({
    referrer: "utm_source=google-play&utm_medium=organic",
  });
  await captureInstallReferrer();
  expect(readStoredInstallReferrer()).toEqual({
    utm_source: "google-play",
    utm_medium: "organic",
  });
});

test("stores nothing when no allowlisted param survives", async () => {
  for (const referrer of ["", "anid=admob&not_a_param=x", undefined]) {
    localStorage.clear();
    read.mockResolvedValueOnce({ referrer });
    await captureInstallReferrer();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  }
});

test("reads the referrer at most once per install", async () => {
  read.mockResolvedValueOnce({ referrer: "utm_source=newsletter" });
  await captureInstallReferrer();
  await captureInstallReferrer();
  expect(read).toHaveBeenCalledTimes(1);
  expect(readStoredInstallReferrer()).toEqual({ utm_source: "newsletter" });
});

test("a spend does not re-arm the bridge", async () => {
  read.mockResolvedValueOnce({ referrer: "utm_source=newsletter" });
  await captureInstallReferrer();

  markInstallReferrerSpent();
  expect(readStoredInstallReferrer()).toEqual({});
  // The emptied key is the spend record, so the shell (which answers `read()`
  // with the same referrer forever) is never asked again. Without it the next
  // user to sign up on this device inherits the first user's campaign.
  expect(localStorage.getItem(STORAGE_KEY)).toBe("");

  read.mockResolvedValue({ referrer: "utm_source=newsletter" });
  await captureInstallReferrer();
  expect(read).toHaveBeenCalledTimes(1);
  expect(readStoredInstallReferrer()).toEqual({});
});

test("a bridge that never answers stores nothing and stays retryable", async () => {
  // A Play Store that binds without ever calling back would otherwise hold the
  // auth flow that awaits this open forever.
  read.mockImplementationOnce(
    () => new Promise<{ referrer?: string }>(() => {}),
  );
  await captureInstallReferrer();
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

  read.mockResolvedValueOnce({ referrer: "utm_source=newsletter" });
  await captureInstallReferrer();
  expect(readStoredInstallReferrer()).toEqual({ utm_source: "newsletter" });
});
