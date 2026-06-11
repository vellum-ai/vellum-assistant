import { afterEach, describe, expect, mock, test } from "bun:test";

// Capture the `client` path param each allauth SDK call receives.
const calls: Array<{ fn: string; client: string }> = [];

function sdkStub(fn: string) {
  return (opts: { path: { client: string } }) => {
    calls.push({ fn, client: opts.path.client });
    return Promise.resolve({
      data: { data: {} },
      error: undefined,
      response: { status: 200 },
    });
  };
}

mock.module("@/generated/auth/sdk.gen", () => ({
  getAllauthByClientV1AuthSession: sdkStub("getSession"),
  deleteAllauthByClientV1AuthSession: sdkStub("logout"),
  getAllauthByClientV1AuthProviderSignup: sdkStub("getProviderSignup"),
  postAllauthByClientV1AuthProviderSignup: sdkStub("submitProviderSignup"),
}));

const { getSession, logout } = await import("@/lib/auth/allauth-client");

function setElectron(): void {
  (window as unknown as { vellum?: unknown }).vellum = { platform: "electron" };
}

afterEach(() => {
  delete (window as unknown as { vellum?: unknown }).vellum;
  calls.length = 0;
});

describe("allauth-client — client selection", () => {
  test("uses the browser client on web", async () => {
    await getSession();
    expect(calls.at(-1)?.client).toBe("browser");
  });

  test("uses the app client in Electron", async () => {
    setElectron();
    await getSession();
    await logout();
    expect(calls.map((c) => c.client)).toEqual(["app", "app"]);
  });
});
