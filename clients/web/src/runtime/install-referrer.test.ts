import { beforeEach, expect, mock, test } from "bun:test";

let platform = "android";
const read = mock(async (): Promise<{ referrer?: string }> => ({}));

mock.module("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => platform },
  registerPlugin: () => ({ read }),
}));

const {
  captureInstallReferrer,
  clearStoredInstallReferrer,
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

  clearStoredInstallReferrer();
  expect(readStoredInstallReferrer()).toEqual({});
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

  read.mockResolvedValueOnce({ referrer: "utm_source=retry" });
  await captureInstallReferrer();
  expect(read).toHaveBeenCalledTimes(2);
  expect(readStoredInstallReferrer()).toEqual({ utm_source: "retry" });
});
