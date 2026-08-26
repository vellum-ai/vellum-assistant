import { beforeEach, expect, mock, test } from "bun:test";

let platform = "android";
const read = mock(async (): Promise<{ referrer?: string }> => ({}));

mock.module("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => platform },
  registerPlugin: () => ({ read }),
}));

const { clearUserScopedStorage } = await import("@/lib/auth/session-cleanup");
const { captureInstallReferrer, markInstallReferrerSpent } =
  await import("./install-referrer");

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
    expect(await captureInstallReferrer()).toEqual({});
  }
  expect(read).not.toHaveBeenCalled();
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
});

test("swallows a shell whose plugin predates this bundle", async () => {
  read.mockRejectedValueOnce(
    new Error('"InstallReferrer" plugin is not implemented on android'),
  );
  expect(await captureInstallReferrer()).toEqual({});
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
});

test("returns and stores only allowlisted params from a campaign referrer", async () => {
  read.mockResolvedValueOnce({
    referrer:
      "utm_source=newsletter&utm_medium=email&utm_campaign=spring&gclid=abc123&anid=admob&not_a_param=x",
  });

  expect(await captureInstallReferrer()).toEqual({
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
  expect(await captureInstallReferrer()).toEqual({
    utm_source: "google-play",
    utm_medium: "organic",
  });
});

test("stores nothing when no allowlisted param survives", async () => {
  for (const referrer of ["", "anid=admob&not_a_param=x", undefined]) {
    localStorage.clear();
    read.mockResolvedValueOnce({ referrer });
    expect(await captureInstallReferrer()).toEqual({});
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  }
});

test("returns a referrer whose storage write was rejected", async () => {
  // Private mode and an exhausted quota reject the write; swapping the whole
  // object is the only way happy-dom's storage refuses one.
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    },
  });
  read.mockResolvedValueOnce({ referrer: "utm_source=newsletter" });
  try {
    expect(await captureInstallReferrer()).toEqual({
      utm_source: "newsletter",
    });
  } finally {
    if (storage) {
      Object.defineProperty(globalThis, "localStorage", storage);
    }
  }
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
});

test("reads the referrer at most once per install", async () => {
  read.mockResolvedValueOnce({ referrer: "utm_source=newsletter" });
  await captureInstallReferrer();

  expect(await captureInstallReferrer()).toEqual({
    utm_source: "newsletter",
  });
  expect(read).toHaveBeenCalledTimes(1);
});

test("a spend does not re-arm the bridge", async () => {
  read.mockResolvedValueOnce({ referrer: "utm_source=newsletter" });
  await captureInstallReferrer();

  markInstallReferrerSpent();
  expect(localStorage.getItem(STORAGE_KEY)).toBe("");

  read.mockResolvedValue({ referrer: "utm_source=newsletter" });
  expect(await captureInstallReferrer()).toEqual({});
  expect(read).toHaveBeenCalledTimes(1);
});

test("a logout leaves the spend record standing", async () => {
  // The record is the emptied key itself, so a logout that swept device-scoped
  // storage by value would re-arm the bridge for whoever signs in next.
  read.mockResolvedValueOnce({ referrer: "utm_source=newsletter" });
  await captureInstallReferrer();
  markInstallReferrerSpent();

  clearUserScopedStorage();

  expect(localStorage.getItem(STORAGE_KEY)).toBe("");
  read.mockResolvedValue({ referrer: "utm_source=newsletter" });
  expect(await captureInstallReferrer()).toEqual({});
  expect(read).toHaveBeenCalledTimes(1);
});

test("a flow that captured nothing leaves the bridge retryable", async () => {
  await captureInstallReferrer();
  markInstallReferrerSpent();
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

  read.mockResolvedValueOnce({ referrer: "utm_source=newsletter" });
  expect(await captureInstallReferrer()).toEqual({
    utm_source: "newsletter",
  });
});
